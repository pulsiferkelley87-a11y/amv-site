# -*- coding: utf-8 -*-
"""把全市场日线从通达信云端 dump 成本地分片 JSON，供 chan 引擎离线扫描。

为什么不用腾讯/东财：本机 Node 出网被拦（腾讯 501、东财 http 断连），
而通达信 TQLEX 一直可用（站点其它数据也走它）。

输出：F:/deepseek会话/amv-chan/out/bars/shard_XX.json
      {"000001": [["2026-11-12", o, c, h, l, v], ...], ...}
"""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tdxhub  # noqa: E402

CLOUD = os.environ.get("CLOUD_DIR") or r"F:/小太阳的聊天记录/amv-cloud"
OUT = os.environ.get("CHAN_BARS") or r"F:/deepseek会话/amv-chan/out/bars"
SHARD = 400
WANT = 700          # 约 3 年日线
WORKERS = 8


def setcode_of(code):
    if code[:1] in ("6", "9"):
        return 1
    if code[:2] in ("43", "83", "87") or code[:1] in ("4", "8"):
        return 2
    return 0


def one(code):
    try:
        j = tdxhub.kline_raw(code, setcode_of(code), period=4, want_num=WANT, startxh=0)
        rows = [x.get("Item") for x in (j.get("ListItem") or [])]
        out = []
        for r in rows:
            # Item 实测字段序：[date, 0, open, high, low, close, amount, amount, volume, ...]
            if not r or len(r) < 9:
                continue
            d = str(r[0])
            d = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 and d.isdigit() else d
            out.append([d, float(r[2]), float(r[5]), float(r[3]), float(r[4]), float(r[8])])
        return code, out
    except Exception as e:
        return code, []


def main():
    os.makedirs(OUT, exist_ok=True)
    data = json.load(open(os.path.join(CLOUD, "data/data.json"), encoding="utf-8"))
    codes = []
    for s in data.get("all_stocks") or []:
        c = str(s.get("code") or "").zfill(6)
        if len(c) == 6 and c.isdigit():
            codes.append(c)
    codes = list(dict.fromkeys(codes))
    print("股票数", len(codes), flush=True)

    t0 = time.time()
    bars = {}
    done = ok = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for code, rows in ex.map(one, codes):
            done += 1
            if rows:
                ok += 1
                bars[code] = rows
            if done % 200 == 0:
                print(f"{done}/{len(codes)} 成功 {ok} 用时 {time.time()-t0:.0f}s", flush=True)

    items = list(bars.items())
    for i in range(0, len(items), SHARD):
        part = dict(items[i:i + SHARD])
        p = os.path.join(OUT, f"shard_{i//SHARD:02d}.json")
        json.dump(part, open(p, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        print("写入", os.path.basename(p), os.path.getsize(p) // 1024, "KB", flush=True)

    print(json.dumps({"codes": len(codes), "ok": ok, "sec": round(time.time() - t0)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
