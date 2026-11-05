#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
make_fundamentals_slim.py — 把 data/fundamentals.json 压成站点可直接发布的瘦身文件。

背景（2026-11-05 事故）：
  update_cloud.py 把 fundamentals 折叠进 app-data.js（10 MB），
  但 app-data.js 是整体重建的 —— 只要那次跑批没带 fundamentals，
  主力资金流面板就会整片空白，而且必须等一次完整的 10 MB 重建才能恢复。

  把 fundamentals 单独发布成一个小文件，前端并行加载后合并进 window.DATA，
  一次基本面更新（约 500 KB）就能让面板生效，与行情主数据彻底解耦。

用法：
  python scripts/make_fundamentals_slim.py                 # 写 <站点根>/fundamentals.json
  python scripts/make_fundamentals_slim.py --out path.json

输出结构（列式，比对象数组小 35% 左右）：
  {"source":..., "updated_at":..., "count":N,
   "cols":["c","mainlx","m3","m5","m10","ddx","ddy","ddz","gdr","free","px"],
   "rows":[["000001",64610368,26424576,...], ...]}
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
DATA_DIR = os.path.join(BASE, "data")

# 列顺序即协议：前端 fundamentals.js 按同一顺序解包，改这里必须同步改前端。
# ipo / pe 是给个股表的「上市」「PE」两列用的 —— 那两列此前在线上全是「—」，
# 因为渲染用的是 stocks_top，而 stocks_top 从来没带过这两个字段。
COLS = ["c", "mainlx", "m3", "m5", "m10", "ddx", "ddy", "ddz", "gdr", "free", "px", "ipo", "pe"]

# 金额类按整数元输出（口径与 app-data.js 的 mainlx 一致，前端 /1e8 转亿）
MONEY = {"mainlx", "m3", "m5", "m10", "gdr"}
# 比率类保留 4 位小数，够用且省字节
RATIO = {"ddx", "ddy", "ddz"}


def _i(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return int(round(f))


def _f(v, nd=4):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:
        return None
    return round(f, nd)


def pick_source(candidates):
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


def build(src_path):
    with open(src_path, encoding="utf-8") as f:
        raw = json.load(f)
    stocks = raw.get("stocks") or {}
    rows = []
    for code, v in stocks.items():
        if not isinstance(v, dict):
            continue
        row = [code]
        for col in COLS[1:]:
            val = v.get(col)
            if col in MONEY:
                row.append(_i(val))
            elif col in RATIO:
                row.append(_f(val, 4))
            elif col == "ipo":
                row.append(str(val) if val else None)   # "19910403"，直接当日期串用
            elif col == "pe":
                row.append(_f(val, 2))
            else:  # free / px
                row.append(_f(val, 4))
        # 整行全空就丢掉，省体积
        if all(x is None for x in row[1:]):
            continue
        rows.append(row)
    rows.sort(key=lambda r: str(r[0]))
    return {
        "source": raw.get("source") or "tdx",
        "updated_at": raw.get("updated_at") or "",
        "count": len(rows),
        "cols": COLS,
        "rows": rows,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(BASE, "fundamentals.json"))
    ap.add_argument("--src", default=None, help="默认依次找 data/fundamentals.json、fundamentals.json")
    args = ap.parse_args()

    src = args.src or pick_source([
        os.path.join(DATA_DIR, "fundamentals.json"),
        os.path.join(BASE, "fundamentals.json"),
    ])
    if not src:
        print("[slim] 找不到 fundamentals 源文件，跳过（不视为错误）", flush=True)
        return 0

    payload = build(src)
    if not payload["count"]:
        print("[slim] 源文件里没有任何个股记录，跳过", flush=True)
        return 0

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, args.out)

    size = os.path.getsize(args.out)
    print("[slim] %s -> %s  %d 只  %.1f KB  updated_at=%s"
          % (os.path.relpath(src, BASE), os.path.relpath(args.out, BASE),
             payload["count"], size / 1024.0, payload["updated_at"]), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
