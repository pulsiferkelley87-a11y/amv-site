# -*- coding: utf-8 -*-
"""fetch_fundamentals.py —— 从通达信 TQLEX 抓全市场基本面（云端可跑，不依赖本地客户端）。

一次 quotes(HasCwInfo=1) 请求即可拿到：
    CwInfo.LTGB   流通股本(万股)     CwInfo.ZGB  总股本(万股)
    CwInfo.Start  上市日期(YYYYMMDD) CwInfo.BelongHY  通达信行业代码
    CwInfo.JLY    净利润(万元)       CwInfo.JZC  净资产(万元)
    CwInfo.YYSR   营业收入(万元)     CwInfo.GDRS 股东人数
    ExtInfo.SYL   市盈率             ExtInfo.MGJZC 每股净资产
    ProInfo.PETTM 滚动市盈率
    StatInfo.Mainlx 主力净流入(元)

实测：并发 8 时 87 只/秒，全市场 5571 只约 1.1 分钟。

用法:
    python scripts/fetch_fundamentals.py [--out data/fundamentals.json] [--workers 8]
产出:
    {"updated_at","count","stocks":{code:{ltgb,zgb,ipo,hy,jly,jzc,yysr,gdr,pe,pettm,mgjzc,mainlx}}}
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
DATA_DIR = os.path.join(BASE, "data")
sys.path.insert(0, HERE)

import tdxhub  # noqa: E402

OPTS = {
    "hasHQInfo": "1",
    "hasExtInfo": "1",
    "hasCwInfo": "1",
    "hasProInfo": "1",
    "hasStatInfo": "1",
    "hasCalcInfo": "0",
    "bspNum": "0",
}


def load_codes():
    """取站点股票池；优先 data/stock_list.json，回落根目录同名文件。"""
    for p in (os.path.join(DATA_DIR, "stock_list.json"),
              os.path.join(BASE, "stock_list.json")):
        if not os.path.exists(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                lst = json.load(f)
        except (OSError, ValueError):
            continue
        out = []
        for x in lst:
            c = str(x.get("code") or "")
            if c.startswith(("sh", "sz", "bj")):
                c = c[2:]
            if len(c) == 6 and c.isdigit():
                out.append(c)
        if out:
            return sorted(set(out))
    return []


def fetch_one(code):
    sc = tdxhub.setcode_of(code)
    try:
        r = tdxhub.quotes(code, sc, opts=OPTS)
    except Exception as e:                      # 单只失败不影响整体
        return code, None, str(e)[:80]
    cw = r.get("CwInfo") or {}
    ex = r.get("ExtInfo") or {}
    pr = r.get("ProInfo") or {}
    st = r.get("StatInfo") or {}
    if not cw and not ex:
        return code, None, "empty"
    return code, {
        "ltgb": cw.get("LTGB") or ex.get("LTGB"),
        "zgb": cw.get("ZGB") or ex.get("ZGB"),
        "ipo": str(cw.get("Start") or ""),
        "hy": cw.get("BelongHY"),
        "jly": cw.get("JLY"),
        "jzc": cw.get("JZC"),
        "yysr": cw.get("YYSR"),
        "gdr": cw.get("GDRS"),
        "pe": ex.get("SYL"),
        "pettm": pr.get("PETTM"),
        "mgjzc": ex.get("MGJZC"),
        "mainlx": st.get("Mainlx"),
        "free": ex.get("FreeLtgb"),
    }, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(DATA_DIR, "fundamentals.json"))
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    codes = load_codes()
    if not codes:
        raise SystemExit("没有股票池（data/stock_list.json 缺失）")
    print(f"股票池 {len(codes)} 只，并发 {args.workers} …", flush=True)

    t0 = time.time()
    stocks, fails = {}, []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for code, row, err in pool.map(fetch_one, codes):
            if row:
                stocks[code] = row
            else:
                fails.append((code, err))
    dt = time.time() - t0
    print(f"完成 {len(stocks)} 只，失败 {len(fails)}，耗时 {dt:.1f}s"
          f"（{len(codes) / max(dt, 0.01):.0f} 只/秒）", flush=True)
    for c, e in fails[:5]:
        print(f"  失败样例 {c}: {e}", flush=True)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    payload = {
        "source": "tdx TQLEX quotes HasCwInfo",
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(stocks),
        "stocks": stocks,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"已写出 {args.out} ({os.path.getsize(args.out) / 1024:.1f} KB)", flush=True)


if __name__ == "__main__":
    main()
