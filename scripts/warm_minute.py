# -*- coding: utf-8 -*-
"""warm_minute.py —— 批量预热分钟线到 COS（云端定时任务用）

做法：
    1. 从 COS 读公开数据，拼出"值得预热的名单"：
         涨停池（live_data.json → limit_up_list）
         龙虎榜（lhb.json → list）
         快上穿（about_to_cross.json → list）
       去重后约 175 只。
    2. 用通达信 TQLEX 取"最近一个交易日"的 1 分钟线（period=7，240 根）。
    3. 写 COS：minute/{code}/{YYYYMMDD}/p7.json —— 与前端读取路径一致。

为什么只预热小集合：
    全市场 5577 只 × 26KB ≈ 145 MB/天，不适合每天都存；
    涨停池/龙虎榜/快上穿这类"当天真正会去看"的票每天才 4~5 MB，
    一个月就能把云端 4.5 个月的窗口铺满，且成本可忽略。

用法：
    python scripts/warm_minute.py                  # 预热最近交易日
    python scripts/warm_minute.py --date 20261105
    python scripts/warm_minute.py --limit 20 -v    # 试跑
    python scripts/warm_minute.py --codes 600000,300071

环境变量（与其它脚本一致）：COS_SECRET_ID / COS_SECRET_KEY，可选 COS_BUCKET / COS_REGION
"""
import argparse
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

BUCKET = os.environ.get("COS_BUCKET", "amv-live-1500351250")
REGION = os.environ.get("COS_REGION", "ap-guangzhou")
SECRET_ID = os.environ.get("COS_SECRET_ID", "")
SECRET_KEY = os.environ.get("COS_SECRET_KEY", "")
BASE = "https://%s.cos.%s.myqcloud.com" % (BUCKET, REGION)


# ─────────────────────────── COS ───────────────────────────
def _auth(method, key):
    now = int(time.time())
    sign_time = "%d;%d" % (now - 60, now + 900)
    key_time = sign_time
    sign_key = hmac.new(SECRET_KEY.encode(), key_time.encode(), hashlib.sha1).hexdigest()
    # COS 签名要求 http_string 里的方法名**小写**（put 不是 PUT），否则 403
    http_string = "%s\n/%s\n\nhost=%s\n" % (method.lower(), key, "%s.cos.%s.myqcloud.com" % (BUCKET, REGION))
    string_to_sign = "sha1\n%s\n%s\n" % (sign_time, hashlib.sha1(http_string.encode()).hexdigest())
    sig = hmac.new(sign_key.encode(), string_to_sign.encode(), hashlib.sha1).hexdigest()
    return ("q-sign-algorithm=sha1&q-ak=%s&q-sign-time=%s&q-key-time=%s"
            "&q-header-list=host&q-url-param-list=&q-signature=%s"
            % (SECRET_ID, sign_time, key_time, sig))


def cos_put(key, body):
    if not (SECRET_ID and SECRET_KEY):
        return None
    host = "%s.cos.%s.myqcloud.com" % (BUCKET, REGION)
    req = urllib.request.Request(
        "https://%s/%s" % (host, key), data=body, method="PUT",
        headers={"Authorization": _auth("PUT", key), "Host": host})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except Exception as e:
        return "ERR:%s" % str(e)[:60]


def cos_exists(key):
    """公开读 HEAD：存在就不用重取，让重复运行很便宜"""
    try:
        req = urllib.request.Request("%s/%s" % (BASE, key), method="HEAD")
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status == 200
    except Exception:
        return False


def get_json(name):
    try:
        with urllib.request.urlopen("%s/%s?t=%d" % (BASE, name, time.time()), timeout=25) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return None


# ─────────────────────────── 名单 ───────────────────────────
def _c6(code):
    s = str(code or "").strip()
    if s[:2].lower() in ("sh", "sz", "bj"):
        s = s[2:]
    return s


def build_universe(verbose=False):
    codes = []

    def add(c, why):
        c6 = _c6(c)
        if len(c6) != 6 or not c6.isdigit():
            return
        if c6 not in seen:
            seen.add(c6)
            codes.append((c6, why))

    seen = set()
    ld = get_json("live_data.json")
    if ld:
        for x in (ld.get("limit_up_list") or []):
            add(x.get("code"), "涨停池")
    lhb = get_json("lhb.json")
    if lhb:
        for x in (lhb.get("list") or []):
            add(x.get("code"), "龙虎榜")
    ac = get_json("about_to_cross.json")
    if ac:
        for x in (ac.get("list") or []):
            add(x.get("code"), "快上穿")
    if verbose:
        from collections import Counter
        print("名单来源:", dict(Counter(w for _, w in codes)))
    return codes


def latest_date():
    ld = get_json("live_data.json")
    ua = (ld or {}).get("updated_at") or ""
    d = "".join(ch for ch in ua[:10] if ch.isdigit())
    if len(d) == 8:
        return d
    return time.strftime("%Y%m%d")


# ─────────────────────────── 主流程 ───────────────────────────

def fetch_latest_day(code, date_str, period=7):
    """只取第一页（最新 700 根）里目标日的数据。

    预热的目标永远是最近一个交易日，而 TQLEX 一页就覆盖约 2.9 个交易日，
    所以**一次请求就够**。用通用 fetch_day 的话，遇到长期停牌或新上市的票
    会掉进翻页逻辑（最多 80 页），批量预热会被拖死。
    """
    import tdx_minute
    sc = tdx_minute.setcode_of(code)
    rows = tdx_minute._page(code, sc, 0, period)
    out = {}
    for r in rows:
        if str(r[0]) == date_str:
            b = tdx_minute._to_bar(r)
            out[b["t"]] = b
    return [out[k] for k in sorted(out.keys())]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default="", help="YYYYMMDD，留空=最近交易日")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--codes", default="", help="直接指定代码，逗号分隔")
    ap.add_argument("--period", type=int, default=7)
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()

    import tdx_minute

    date = (a.date or "").replace("-", "") or latest_date()
    if a.codes:
        uni = [(_c6(c), "指定") for c in a.codes.split(",") if _c6(c)]
    else:
        uni = build_universe(a.verbose)
    if a.limit:
        uni = uni[:a.limit]

    print("预热日期: %s  标的数: %d  period=%d" % (date, len(uni), a.period))
    if not (SECRET_ID and SECRET_KEY):
        print("警告: 未设置 COS_SECRET_ID/COS_SECRET_KEY —— 只取数不上传")

    ok = skip = fail = empty = 0
    t0 = time.time()
    for i, (code, why) in enumerate(uni, 1):
        key = "minute/%s/%s/p%d.json" % (code, date, a.period)
        if cos_exists(key):
            skip += 1
            continue
        try:
            bars = fetch_latest_day(code, date, a.period)
        except Exception as e:
            fail += 1
            if a.verbose:
                print("  [%d/%d] %s 取数失败 %s" % (i, len(uni), code, str(e)[:60]))
            continue
        if not bars:
            empty += 1
            if a.verbose:
                print("  [%d/%d] %s(%s) 无数据" % (i, len(uni), code, why))
            continue
        st = cos_put(key, json.dumps(
            {"code": code, "date": date, "period": a.period, "bars": bars},
            ensure_ascii=False).encode("utf-8"))
        if st == 200:
            ok += 1
        else:
            fail += 1
        if a.verbose or i % 25 == 0:
            print("  [%d/%d] %s(%s) %d 根 -> %s" % (i, len(uni), code, why, len(bars), st))

    print("完成：新增 %d ｜ 已存在跳过 %d ｜ 无数据 %d ｜ 失败 %d ｜ 耗时 %.1fs"
          % (ok, skip, empty, fail, time.time() - t0))
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
