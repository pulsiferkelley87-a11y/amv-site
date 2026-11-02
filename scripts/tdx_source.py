# -*- coding: utf-8 -*-
"""tdx_source.py —— 通达信云端数据源适配层（TQLEX），供数据管线使用。

与 tdxhub.py 的分工：
    tdxhub.py      技能/CLI 用的散装客户端，返回原始 JSON
    tdx_source.py  管线用的数据源，统一输出行格式 + 并发 + 重试 + 降级链

行格式（与 update_cloud.py 现有源对齐）：
    {"date": "YYYYMMDD", "open", "high", "low", "close", "amount", "volume"(手), "turnover"}

实测（2026-11-02）：
    - PBHQInfo 快照 225ms，PBFXT 日线 250 根 98ms
    - 串行 20 只 × 60 根 = 1.5s（75ms/只）；5000 只串行约 6 分钟，用并发可压到 1 分钟内
    - 与本地 vipdoc 交叉验证：299 个共同交易日 OHLC/成交额 100% 一致
    - 单位：TQLEX Volume 为「股」，本模块 /100 转「手」；
      本地 .day 的 +24 字段同为「股」，读取后同样 /100

注意：云端比本地 vipdoc 新。本地只在通达信客户端同步过之后才有当日数据。
"""
import json
import os
import struct
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ENDPOINT = "http://tdxhub.icfqs.com:7615/TQLEX"
TIMEOUT = 15
RETRIES = 3

# 本地 vipdoc 根目录候选（按优先级）
VIPDOC_CANDIDATES = (
    r"F:\tongdaxin\vipdoc",
    r"C:\new_tdx\vipdoc",
)


def setcode_of(code):
    """按代码前缀推断 setcode：'6'->1(沪) '0'/'3'->0(深) '4'/'8'/'9'->2(北)。"""
    c = str(code).strip()
    if c[:2].lower() in ("sh", "sz", "bj"):
        c = c[2:]
    if c.startswith("6"):
        return 1
    if c.startswith(("0", "3")):
        return 0
    if c.startswith(("4", "8", "9")):
        return 2
    return None


def _post(entry, body, timeout=TIMEOUT, retries=RETRIES):
    """POST JSON 到 TQLEX；网络错误与 5xx 退避重试，业务错误直接抛。"""
    url = ENDPOINT + "?Entry=" + entry
    payload = json.dumps(body).encode("utf-8")
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(
            url, data=payload,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                text = r.read().decode("utf-8", "replace")
            if text.startswith("E|"):
                raise RuntimeError("TQLEX 业务错误: " + text[:200])
            return json.loads(text)
        except urllib.error.HTTPError as e:
            last = e
            if e.code < 500 and e.code != 429:
                raise
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
        if attempt < retries - 1:
            time.sleep(0.6 * (attempt + 1))
    raise RuntimeError("TQLEX 请求失败（重试 %d 次）: %s" % (retries, last))


def _head():
    return {"Head": {"Target": "0", "CharSet": "UTF8"}}


def quotes(code, setcode=None):
    """实时快照。返回 HQInfo 字典（无数据时为空 dict）。"""
    sc = setcode if setcode is not None else setcode_of(code)
    body = dict(_head())
    body.update({
        "Code": str(code), "Setcode": str(sc),
        "HasHQInfo": "1", "HasExtInfo": "1", "BspNum": "5",
        "HasProInfo": "0", "HasCalcInfo": "0", "HasCwInfo": "0", "HasStatInfo": "0",
    })
    j = _post("TdxShare.PBHQInfo", body)
    return j.get("HQInfo") or {}


def daily(code, want_num=250, setcode=None, period=4):
    """日线（升序）。period: 4=日 5=周 6=月。

    返回 [{"date","open","high","low","close","amount","volume","turnover"}]
    volume 单位为「手」（TQLEX 原始为股，已 /100）；turnover 恒为 None（沿用 tdxhub 口径）。
    """
    sc = setcode if setcode is not None else setcode_of(code)
    body = dict(_head())
    body.update({
        "Code": str(code), "Setcode": int(sc), "Period": int(period),
        "Startxh": 0, "WantNum": int(want_num), "TQFlag": 11, "MPData": 0,
        "HasAttachInfo": 1, "HasLtgb": 0, "ForRefresh": 0, "HasIpoPrice": 0,
    })
    j = _post("TdxShare.PBFXT", body)
    out = []
    for row in j.get("ListItem") or []:
        it = row.get("Item") or []
        if len(it) < 9 or not it[0]:
            continue
        try:
            out.append({
                "date": str(it[0]),
                "open": float(it[2]), "high": float(it[3]),
                "low": float(it[4]), "close": float(it[5]),
                "amount": float(it[6]),
                "volume": round(float(it[8]) / 100.0),  # 股 -> 手
                "turnover": None,
            })
        except (TypeError, ValueError):
            continue
    out.sort(key=lambda r: r["date"])
    return out


# ───────────────────────── 本地 vipdoc 降级源 ─────────────────────────

def _vipdoc_root():
    for root in VIPDOC_CANDIDATES:
        if os.path.isdir(root):
            return root
    return None


def _market_of(code):
    sc = setcode_of(code)
    return {1: "sh", 0: "sz", 2: "bj"}.get(sc)


def local_day_path(code):
    """定位本地 .day 文件；不存在返回 None。"""
    root = _vipdoc_root()
    mk = _market_of(code)
    if not root or not mk:
        return None
    c = str(code).strip()
    if c[:2].lower() in ("sh", "sz", "bj"):
        c = c[2:]
    p = os.path.join(root, mk, "lday", "%s%s.day" % (mk, c))
    return p if os.path.isfile(p) else None


def read_local_day(code, want_num=250):
    """读本地 .day（32 字节定长，小端）。

    布局：+0 uint32 日期YYYYMMDD / +4 open×100 / +8 high×100 / +12 low×100
          / +16 close×100 / +20 float32 成交额(元) / +24 uint32 成交量(股) / +28 保留

    **单位注意**：+24 是「股」，本函数 /100 转「手」，与 daily() 对齐。
    """
    path = local_day_path(code)
    if not path:
        return []
    with open(path, "rb") as f:
        data = f.read()
    cnt = len(data) // 32
    start = max(0, cnt - int(want_num))
    out = []
    for i in range(start, cnt):
        o = i * 32
        d, op, hi, lo, cl = struct.unpack_from("<IIIII", data, o)
        amt = struct.unpack_from("<f", data, o + 20)[0]
        vol = struct.unpack_from("<I", data, o + 24)[0]
        out.append({
            "date": str(d),
            "open": op / 100.0, "high": hi / 100.0,
            "low": lo / 100.0, "close": cl / 100.0,
            "amount": float(amt),
            "volume": round(vol / 100.0),  # 股 -> 手
            "turnover": None,
        })
    return out


def daily_with_fallback(code, want_num=250):
    """优先云端，失败或为空则退本地。返回 (rows, source)。"""
    try:
        rows = daily(code, want_num)
        if rows:
            return rows, "tdxhub"
    except Exception:
        pass
    rows = read_local_day(code, want_num)
    if rows:
        return rows, "local_vipdoc"
    return [], "none"


def batch_daily(codes, want_num=60, workers=8):
    """并发拉多只。返回 {code: {"rows": [...], "source": str, "error": str|None}}。"""
    result = {}

    def one(code):
        try:
            rows, src = daily_with_fallback(code, want_num)
            result[code] = {"rows": rows, "source": src, "error": None}
        except Exception as e:  # noqa: BLE001 - 单只失败不应中断整批
            result[code] = {"rows": [], "source": "none", "error": str(e)[:200]}

    with ThreadPoolExecutor(max_workers=max(1, int(workers))) as pool:
        list(pool.map(one, codes))
    return result
