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
from concurrent.futures import ThreadPoolExecutor
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




def apply_shard(uni, spec):
    """--shard K/N：按 K/N 交错切片，多个 runner 并行时负载均衡。

    交错（i % N == K）而不是连续切段：不同市场/板块的票在名单里是混排的，
    交错能让每个分片都覆盖到各类票，避免某个分片全是停牌股。
    """
    spec = (spec or "").strip()
    if not spec or "/" not in spec:
        return uni
    try:
        k, n = spec.split("/")
        k, n = int(k), int(n)
    except ValueError:
        return uni
    if n <= 1 or k < 0 or k >= n:
        return uni
    return [x for i, x in enumerate(uni) if i % n == k]


def all_market_codes():
    """全市场代码（来自 live_data.json 的 stocks，约 5500 只）"""
    ld = get_json("live_data.json")
    out = []
    for s in ((ld or {}).get("stocks") or []):
        c = _c6(s.get("code"))
        if len(c) == 6 and c.isdigit():
            out.append((c, "全市场"))
    return out


def build_universe(verbose=False, top_flow=50):
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

    # 主力净流入 Top N：fundamentals.json 是列式存储，cols 里找 c / mainlx
    fu = get_json("fundamentals.json")
    if fu and fu.get("rows"):
        cols = fu.get("cols") or []
        try:
            ic = cols.index("c")
            im = cols.index("mainlx")
        except ValueError:
            ic, im = 0, 1
        rows = []
        for r in fu["rows"]:
            try:
                v = r[im]
                if v is None:
                    continue
                rows.append((float(v), r[ic]))
            except (TypeError, ValueError):
                continue
        rows.sort(reverse=True)
        for v, c in rows[:top_flow]:
            add(c, "主力净流入")
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


def trading_days(n):
    """用 600000 的日线当交易日历（浦发极少停牌，做日历足够稳）。"""
    import tdxhub
    j = tdxhub.kline_raw("600000", 1, period=4, want_num=min(n + 10, 700), startxh=0)
    rows = [x.get("Item") for x in (j.get("ListItem") or [])]
    ds = sorted({str(r[0]) for r in rows})
    return ds[-n:] if n and len(ds) >= n else ds


def fetch_range(code, need, period=7):
    """一次翻页把该股翻到窗口最早日期，按日分组。

    回填时"按股票翻页"比"按日期逐日查"快一个数量级：
    每页 700 根 ≈ 2.9 天，100 个交易日 ≈ 35 页；逐日查则是 100 次二分查找。
    """
    import tdx_minute
    sc = tdx_minute.setcode_of(code)
    need = set(need)
    if not need:
        return {}
    oldest = min(need)
    out = {}
    for page in range(tdx_minute.MAX_PAGES):
        rows = tdx_minute._page(code, sc, page * tdx_minute.PAGE, period)
        if not rows:
            break
        for r in rows:
            d = str(r[0])
            if d in need:
                b = tdx_minute._to_bar(r)
                out.setdefault(d, {})[b["t"]] = b
        ds = [str(r[0]) for r in rows]
        if min(ds) < oldest:
            break
    return {d: [v[k] for k in sorted(v.keys())] for d, v in out.items()}


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
    if out:
        return [out[k] for k in sorted(out.keys())]

    # 目标日比第一页更早 → 走二分定位（约 6~8 次请求）。
    # 只在这种情况下回退，避免停牌股掉进翻页黑洞。
    ds0 = [str(r[0]) for r in rows] if rows else []
    if ds0 and date_str < min(ds0):
        r2 = tdx_minute.fetch_day(code, date_str, period=period)
        return r2.get("bars") or []
    return []



def run_backfill(a, put_workers=8):
    uni = [(_c6(c), "指定") for c in a.codes.split(",") if _c6(c)] if a.codes \
        else (all_market_codes() if a.all else build_universe(a.verbose, a.top_flow))
    uni = apply_shard(uni, getattr(a, "shard", ""))
    if a.limit:
        uni = uni[:a.limit]
    days = trading_days(a.backfill)
    if not days:
        print("拿不到交易日历")
        return 1
    print("回填 %d 个交易日（%s ~ %s），标的 %d 只，period=%d"
          % (len(days), days[0], days[-1], len(uni), a.period))

    files = codes_ok = empty = fail = 0
    t0 = time.time()
    for i, (code, why) in enumerate(uni, 1):
        try:
            by_date = fetch_range(code, days, a.period)
        except Exception as e:
            fail += 1
            if a.verbose:
                print("  [%d/%d] %s 取数失败 %s" % (i, len(uni), code, str(e)[:50]))
            continue
        if not by_date:
            empty += 1
            continue
        codes_ok += 1
        jobs = []
        for d, bars in by_date.items():
            key = "minute/%s/%s/p%d.json" % (code, d, a.period)
            jobs.append((key, json.dumps(
                {"code": code, "date": d, "period": a.period, "bars": bars},
                ensure_ascii=False).encode("utf-8")))
        # 上传并发：单只 100 天 = 100 次 PUT，串行每只 100s 会把整轮拖到十几小时
        if jobs:
            with ThreadPoolExecutor(max_workers=put_workers) as ex:
                for st in ex.map(lambda kv: cos_put(kv[0], kv[1]), jobs):
                    if st == 200:
                        files += 1
                    else:
                        fail += 1
        if a.verbose or i % 10 == 0:
            print("  [%d/%d] %s(%s) 覆盖 %d 天，累计文件 %d，%.0fs"
                  % (i, len(uni), code, why, len(by_date), files, time.time() - t0))

    print("回填完成：%d 只 × 平均 %.1f 天 = %d 个文件 ｜ 无数据 %d 只 ｜ 失败 %d ｜ 耗时 %.0fs"
          % (codes_ok, files / max(1, codes_ok), files, empty, fail, time.time() - t0))
    return 0 if fail == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default="", help="YYYYMMDD，留空=最近交易日")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--codes", default="", help="直接指定代码，逗号分隔")
    ap.add_argument("--period", type=int, default=7)
    ap.add_argument("--backfill", type=int, default=0,
                    help="回填最近 N 个交易日（按股票翻页，一次覆盖整段）")
    ap.add_argument("--put-workers", type=int, default=8,
                    help="回填时并发上传数（默认 8）")
    ap.add_argument("--all", action="store_true",
                    help="用全市场（live_data.json 的 stocks）而不是精选名单")
    ap.add_argument("--shard", default="",
                    help="分片 K/N：只处理第 K 片（0 基），用于多 runner 并行")
    ap.add_argument("--list", action="store_true", help="只打印预热名单，不取数")
    ap.add_argument("--top-flow", type=int, default=50,
                    help="名单里额外加入主力净流入前 N 名")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--skip-existing", action="store_true",
                    help="先用 HEAD 查已有（慢，约 0.2s/只）；默认直接覆盖写，幂等")
    a = ap.parse_args()

    import tdx_minute

    pick = all_market_codes if a.all else (lambda: build_universe(a.verbose, a.top_flow))

    if a.list:
        from collections import Counter
        uni = pick()
        print("预热名单 %d 只（每交易日 16:10 自动取这些票的当日分时）" % len(uni))
        for c, why in uni:
            print("  %s  %s" % (c, why))
        print("来源构成:", dict(Counter(w for _, w in uni)))
        return 0

    if a.backfill:
        return run_backfill(a, max(1, a.put_workers))

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
        if a.skip_existing and cos_exists(key):
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
