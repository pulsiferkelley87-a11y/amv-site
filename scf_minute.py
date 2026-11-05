# -*- coding: utf-8 -*-
"""scf_minute.py —— 腾讯云函数：通达信分钟线（分时）HTTP 接口

为什么放在云端：
    TQLEX 是 http://tdxhub.icfqs.com:7615（明文 + 无 CORS），浏览器不能直连；
    而云函数在广州，访问它又快又稳，且能以 https + CORS 暴露给前端。

部署方式（两种都用同一个入口）：
    1) 与 index.py 放同一函数包（推荐）：本文件 `from index import cos_get, cos_put`
       直接复用那边已经写好的纯标准库 COS 签名。函数入口改成 scf_minute.main_handler。
    2) 单独一个函数：把 index.py 里的 cos_sign/cos_get/cos_put 一起带上即可。

调用方式：
    HTTP（API 网关，GET）：/minute?code=600000&date=20260915[&period=7][&force=1]
    HTTP（POST）        ：{"code":"600000","date":"20260915","period":7}
    定时预热            ：{"warm":["600000","300071"],"date":"20260915"}

返回：
    {"ok":true,"code":"600000","date":"20260915","period":7,
     "bars":[{t,o,h,l,c,amt,vol},...],"source":"cos"|"tdx","ms":123}

设计要点：
    - COS 先查缓存（minute/{code}/{date}.json），命中直接返回，不打 TQLEX；
    - 未命中才翻页取数，取完写回 COS —— 同一只票同一天只会真正抓一次；
    - 纯标准库（urllib），与 index.py 保持一致，云函数不需要装依赖。
"""
import hashlib
import hmac
import http.client
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

# ── COS 读写（纯标准库，自带签名，不依赖同包的 index.py） ──────────────
COS_SECRET_ID = os.environ.get("COS_SECRET_ID", "")
COS_SECRET_KEY = os.environ.get("COS_SECRET_KEY", "")
COS_BUCKET = os.environ.get("COS_BUCKET", "amv-live-1500351250")
COS_REGION = os.environ.get("COS_REGION", "ap-guangzhou")


def _cos_auth(method, path):
    """COS 请求签名。注意 http_string 里的方法名必须小写（put 不是 PUT），否则 403。"""
    now = int(time.time())
    sign_time = "%d;%d" % (now - 60, now + 900)
    key_time = sign_time
    sign_key = hmac.new(COS_SECRET_KEY.encode(), key_time.encode(), hashlib.sha1).hexdigest()
    host = "%s.cos.%s.myqcloud.com" % (COS_BUCKET, COS_REGION)
    http_string = "%s\n/%s\n\nhost=%s\n" % (method.lower(), path, host)
    string_to_sign = "sha1\n%s\n%s\n" % (sign_time, hashlib.sha1(http_string.encode()).hexdigest())
    sig = hmac.new(sign_key.encode(), string_to_sign.encode(), hashlib.sha1).hexdigest()
    return ("q-sign-algorithm=sha1&q-ak=%s&q-sign-time=%s&q-key-time=%s"
            "&q-header-list=host&q-url-param-list=&q-signature=%s"
            % (COS_SECRET_ID, sign_time, key_time, sig))


def cos_get(path, timeout=20):
    url = "https://%s.cos.%s.myqcloud.com/%s" % (COS_BUCKET, COS_REGION, path)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.read()
    except Exception:
        return None


def cos_put(path, content, timeout=30):
    if not (COS_SECRET_ID and COS_SECRET_KEY):
        return False
    host = "%s.cos.%s.myqcloud.com" % (COS_BUCKET, COS_REGION)
    req = urllib.request.Request(
        "https://%s/%s" % (host, path), data=content, method="PUT",
        headers={"Authorization": _cos_auth("PUT", path), "Host": host})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


TQLEX = os.environ.get("TDX_ENDPOINT", "http://tdxhub.icfqs.com:7615/TQLEX")
PAGE = 700            # TQLEX 单次上限
MAX_PAGES = 80        # 最多往回翻 80 页（≈230 交易日）
TIMEOUT = 12

# 实测编码：7=1分钟 0=5分钟 1=15分钟 2=30分钟 3=60分钟 4=日线
PERIOD_OK = (7, 0, 1, 2, 3, 4)

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60",
}


# ─────────────────────────── TQLEX ───────────────────────────
_CONN = None


def _conn():
    """复用同一条 HTTP 连接。

    urllib 每次新建连接，实测一次请求要 4.7 秒（TCP 握手开销占绝大部分）；
    复用长连接后单次降到百毫秒级 —— 取一天分时要发 8~10 次请求，差别是 47 秒 vs 1~2 秒。
    """
    global _CONN
    if _CONN is None:
        u = urllib.parse.urlparse(TQLEX)
        _CONN = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=TIMEOUT)
    return _CONN


def _post(entry, body, timeout=TIMEOUT):
    global _CONN
    u = urllib.parse.urlparse(TQLEX)
    path = (u.path or "/") + "?Entry=" + entry
    payload = json.dumps(body).encode("utf-8")
    last = None
    for attempt in (0, 1):
        try:
            c = _conn()
            c.timeout = timeout
            c.request("POST", path, body=payload,
                      headers={"Content-Type": "application/json"})
            r = c.getresponse()
            return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:          # 连接可能被服务端关掉，重连一次
            last = e
            try:
                if _CONN:
                    _CONN.close()
            except Exception:
                pass
            _CONN = None
            if attempt:
                break
    raise last if last else RuntimeError("TQLEX 请求失败")


def _head():
    return {"Target": 0, "Index": 0, "Range": 0, "PageIndex": 0, "PageSize": 0}


def _setcode(code):
    c = str(code)
    # 顺序很重要：北交所要先判。
    # 原来沪市那一行里有个裸 "9"，会把 92xxxx（北交所）吞成沪市，
    # 结果北交所股票一律取不到数据（Setcode 错，接口返回空）。
    if c.startswith(("92", "4", "8", "43", "83", "87")):
        return 2
    if c.startswith(("60", "68", "5", "9", "11", "13")):
        return 1
    return 0


def _page(code, setcode, startxh, period):
    body = dict(_head())
    body.update({
        "Code": str(code), "Setcode": int(setcode), "Period": int(period),
        "Startxh": int(startxh), "WantNum": PAGE, "TQFlag": 11, "MPData": 0,
        "HasAttachInfo": 1, "HasLtgb": 0, "ForRefresh": 0, "HasIpoPrice": 0,
    })
    j = _post("TdxShare.PBFXT", body)
    return [x.get("Item") for x in (j.get("ListItem") or [])]


def _bar(item):
    sec = int(float(item[1]))
    return {
        "t": "%02d%02d" % (sec // 3600, (sec % 3600) // 60),
        "o": round(float(item[2]), 3), "h": round(float(item[3]), 3),
        "l": round(float(item[4]), 3), "c": round(float(item[5]), 3),
        "amt": round(float(item[6]), 2),
        "vol": round(float(item[8]) / 100.0, 0),   # 股 → 手
    }


def fetch_day(code, date_str, period=7):
    """取某一天的分钟线。

    线性从最近往回翻太慢（1 分钟线翻到 4 个月前要 30+ 次请求，实测 52 秒）。
    页号与日期单调（页号越大越老），所以先**二分定位页号**再取，
    请求数从 30+ 降到 6~8 次。
    """
    date_str = str(date_str).replace("-", "")
    sc = _setcode(code)

    def page_range(page):
        rows = _page(code, sc, page * PAGE, period)
        if not rows:
            return None
        ds = [str(r[0]) for r in rows]
        return min(ds), max(ds)

    r0 = page_range(0)
    if r0 is None:
        return []                     # 该股无数据
    if date_str > r0[1]:
        return []                     # 目标日晚于最新一天（还没到这个交易日）
    def page_dates(page):
        r = page_range(page)
        return r[0] if r else None

    lo, hi = 0, MAX_PAGES - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        mn = page_dates(mid)
        if mn is None:                # 越过云端边界
            hi = mid
            continue
        if mn > date_str:
            lo = mid                  # 这页还太新 → 往更老的页走
        else:
            hi = mid                  # 已翻过 → 往回退

    found = {}
    for page in (lo, lo + 1, lo + 2):
        if page >= MAX_PAGES:
            break
        rows = _page(code, sc, page * PAGE, period)
        if not rows:
            break
        for r in rows:
            if str(r[0]) == date_str:
                b = _bar(r)
                found[b["t"]] = b
    return [found[k] for k in sorted(found.keys())]


# ─────────────────────────── 缓存 ───────────────────────────
def _cache_key(code, date_str, period):
    return "minute/%s/%s/p%d.json" % (code, date_str, period)


def _cache_read(code, date_str, period):
    try:
        raw = cos_get(_cache_key(code, date_str, period))
        if raw:
            j = json.loads(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
            if j.get("bars"):
                return j
    except Exception:
        pass
    return None


def _cache_write(code, date_str, period, payload):
    try:
        cos_put(_cache_key(code, date_str, period),
                json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        return True
    except Exception:
        return False


# ─────────────────────────── 业务 ───────────────────────────
def get_minute(code, date_str, period=7, force=False):
    t0 = time.time()
    date_str = str(date_str).replace("-", "")
    code = str(code)
    if period not in PERIOD_OK:
        period = 7

    if not force:
        hit = _cache_read(code, date_str, period)
        if hit:
            hit["source"] = "cos"
            hit["ms"] = int((time.time() - t0) * 1000)
            return hit

    bars = fetch_day(code, date_str, period)
    payload = {"ok": bool(bars), "code": code, "date": date_str,
               "period": period, "bars": bars,
               "source": "tdx", "ms": int((time.time() - t0) * 1000),
               "at": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")}
    if bars:
        _cache_write(code, date_str, period, payload)
    return payload


def _resp(obj, status=200):
    return {"statusCode": status, "headers": CORS,
            "body": json.dumps(obj, ensure_ascii=False),
            "isBase64Encoded": False}


def _parse(event):
    """兼容 API 网关(GET/POST) 与 直接调用(dict)"""
    ev = event or {}
    if isinstance(ev, dict) and ("queryStringParameters" in ev or "requestContext" in ev):
        q = ev.get("queryStringParameters") or {}
        body = {}
        if ev.get("body"):
            raw = ev["body"]
            if ev.get("isBase64Encoded"):
                import base64
                raw = base64.b64decode(raw).decode("utf-8", "replace")
            try:
                body = json.loads(raw)
            except Exception:
                body = {}
        return {**body, **q}
    return ev if isinstance(ev, dict) else {}


def main_handler(event, context=None):
    ev = _parse(event)
    method = ""
    if isinstance(event, dict):
        method = (event.get("httpMethod") or "").upper()
    if method == "OPTIONS":
        return _resp({"ok": True})

    # 预热：一次给多只票拉同一天
    warm = ev.get("warm")
    if warm:
        date_str = str(ev.get("date") or datetime.now(
            timezone(timedelta(hours=8))).strftime("%Y%m%d"))
        codes = warm if isinstance(warm, list) else str(warm).split(",")
        out = []
        for c in codes[:200]:
            r = get_minute(c.strip(), date_str, int(ev.get("period") or 7))
            out.append({"code": c.strip(), "bars": len(r.get("bars") or [])})
        return _resp({"ok": True, "warm": date_str, "result": out})

    code = str(ev.get("code") or "").strip()
    date_str = str(ev.get("date") or "").strip()
    if not code or not date_str:
        return _resp({"ok": False, "error": "需要 code 与 date（YYYYMMDD）"}, 400)
    period = int(ev.get("period") or 7)
    force = str(ev.get("force") or "") in ("1", "true", "True")
    try:
        return _resp(get_minute(code, date_str, period, force))
    except urllib.error.URLError as e:
        return _resp({"ok": False, "error": "TQLEX 不可达: %s" % str(e)[:120]}, 502)
    except Exception as e:
        return _resp({"ok": False, "error": str(e)[:200]}, 500)


if __name__ == "__main__":
    # 本地自测：模拟 API 网关 GET
    ev = {"httpMethod": "GET", "queryStringParameters": {"code": "600000", "date": "20260915"}}
    r = main_handler(ev)
    print(r["statusCode"])
    j = json.loads(r["body"])
    print(json.dumps({k: v for k, v in j.items() if k != "bars"}, ensure_ascii=False))
    print("bars:", len(j.get("bars") or []))
    if j.get("bars"):
        print("first:", j["bars"][0])
        print("last :", j["bars"][-1])
