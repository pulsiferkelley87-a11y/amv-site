# -*- coding: utf-8 -*-
"""tdx_minute.py —— 用通达信 TQLEX 取任意历史日期的 1 分钟线（分时）

为什么需要这个：
    网页是静态站（GitHub Pages + COS），浏览器不能直连通达信 TQLEX：
      - TQLEX 是 http 明文，https 页面请求会被当混合内容拦截
      - 且没有 CORS 头
    所以通达信的分钟线只能由管线（本机/服务器）取下来，落成 JSON 放到 COS，
    前端再去读 —— 和本站其它数据（live_data.json / bull_bear.json）同一条路。

关键事实（2026-11-05 实测，600000）：
    period=7  → 1 分钟线，单次上限 700 根（约 2.9 个交易日）
    Startxh   → 翻页游标，等价于"往回数多少根"，可一直翻
    period 编码：7=1分钟 0=5分钟 1=15分钟 2=30分钟 3=60分钟 4=日线
    （tdxhub.py 注释里的编码表是错的，以本文件实测为准）

用法：
    python tdx_minute.py 600000 20260915          # 取某天分时
    python tdx_minute.py 600000 20260915 --json   # 输出 JSON 到 stdout
    python tdx_minute.py 600000 --range 20260901 20260915
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tdxhub  # noqa: E402

PAGE = 700          # TQLEX 单次上限
MAX_PAGES = 80      # 最多往回翻 80 页（≈230 个交易日），防止死循环


def setcode_of(code: str) -> int:
    """'1'=沪 '0'=深 '2'=北（与 tdxhub.setcode_of 一致，这里显式化便于阅读）"""
    c = str(code)
    if c.startswith(("60", "68", "5", "9", "11", "13")):
        return 1
    if c.startswith(("4", "8", "92", "43", "83", "87")):
        return 2
    return 0


def _page(code, setcode, startxh, period=7):
    j = tdxhub.kline_raw(code, setcode, period=period, want_num=PAGE, startxh=startxh)
    return [x.get("Item") for x in (j.get("ListItem") or [])]


def _to_bar(item):
    """Item: [Data,Second,Open,High,Low,Close,Amount,VolInStock,Volume,Settle,up,down]"""
    sec = int(float(item[1]))
    return {
        "d": str(item[0]),                 # YYYYMMDD
        "t": "%02d%02d" % (sec // 3600, (sec % 3600) // 60),
        "o": round(float(item[2]), 3),
        "h": round(float(item[3]), 3),
        "l": round(float(item[4]), 3),
        "c": round(float(item[5]), 3),
        "amt": round(float(item[6]), 2),   # 元
        "vol": round(float(item[8]) / 100.0, 0),  # 股 → 手
    }


def fetch_day(code, date_str, verbose=False, period=7):
    """取某一天的 1 分钟线。date_str 形如 20260915（也接受 2026-09-15）。

    返回 {"code","date","bars":[...]}，取不到返回 bars 为空。
    从最近开始往回翻页，直到翻过目标日期。
    """
    date_str = str(date_str).replace("-", "")
    sc = setcode_of(code)
    found = {}
    for page in range(MAX_PAGES):
        rows = _page(code, sc, page * PAGE, period)
        if not rows:
            break
        dates = [str(r[0]) for r in rows]
        if verbose:
            print("  第 %2d 页: %d 根, %s ~ %s" % (page + 1, len(rows), dates[-1], dates[0]))
        for r in rows:
            if str(r[0]) == date_str:
                b = _to_bar(r)
                found[b["t"]] = b
        # 这一页最早的一天已经早于目标日 → 再往前翻也不会有目标日了
        if dates and min(dates) < date_str:
            break
        if not rows:
            break
        time.sleep(0.05)      # 轻微间隔，别把接口打急
    bars = [found[k] for k in sorted(found.keys())]
    return {"code": str(code), "date": date_str, "bars": bars}


def coverage(code, period=7):
    """探测该股该周期在云端最早能到哪天、大约多少根（二分找 Startxh 边界）"""
    sc = setcode_of(code)

    def at(sx):
        rows = _page(code, sc, sx, period)
        if not rows:
            return None
        d = sorted(set(str(r[0]) for r in rows))
        return d[0]

    if at(0) is None:
        return {"code": str(code), "period": period, "earliest": None, "bars": 0}
    lo, hi = 0, 400000
    while hi - lo > PAGE:
        mid = (lo + hi) // 2
        if at(mid):
            lo = mid
        else:
            hi = mid
    return {"code": str(code), "period": period, "earliest": at(lo), "bars": lo + PAGE}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("code")
    ap.add_argument("date", nargs="?", help="YYYYMMDD 或 YYYY-MM-DD")
    ap.add_argument("--range", nargs=2, metavar=("FROM", "TO"))
    ap.add_argument("--json", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("-p", "--period", type=int, default=7,
                    help="7=1分钟 0=5分钟 1=15分钟 2=30分钟 3=60分钟 4=日线")
    ap.add_argument("--coverage", action="store_true", help="只看云端覆盖到哪天")
    a = ap.parse_args()

    if a.coverage:
        print(json.dumps(coverage(a.code, a.period), ensure_ascii=False))
        return

    if a.range:
        out = []
        d0 = a.range[0].replace("-", "")
        d1 = a.range[1].replace("-", "")
        # 简化：逐日调用（日期列表由调用方保证）
        for d in (d0, d1):
            r = fetch_day(a.code, d, a.verbose)
            out.append(r)
            print("%s %s: %d 根" % (a.code, r["date"], len(r["bars"])))
        if a.json:
            print(json.dumps(out, ensure_ascii=False))
        return

    if not a.date:
        ap.error("需要 date 或 --range")
    r = fetch_day(a.code, a.date, a.verbose, a.period)
    if a.json:
        print(json.dumps(r, ensure_ascii=False))
        return
    print("%s %s: %d 根 1分钟线" % (r["code"], r["date"], len(r["bars"])))
    for b in r["bars"][:3] + (["..."] if len(r["bars"]) > 6 else []) + r["bars"][-3:]:
        if b == "...":
            print("  ...")
            continue
        print("  %s  O%.2f H%.2f L%.2f C%.2f  %s手  %.2f万元" %
              (b["t"], b["o"], b["h"], b["l"], b["c"], int(b["vol"]), b["amt"] / 1e4))


if __name__ == "__main__":
    main()
