# -*- coding: utf-8 -*-
"""chan_summary.py — 打印 chan_scan.json 摘要（CI 日志 / Step Summary 用）。"""
import json
import os
import sys

p = "_chan/out/chan_scan.json"
if not os.path.exists(p):
    p = "chan_scan.json"
if not os.path.exists(p):
    print("chan_scan.json missing")
    sys.exit(0)

j = json.load(open(p, encoding="utf-8"))
print("updated_at:", j.get("updated_at"))
print("ok/fail:", j.get("ok"), "/", j.get("fail"))
print("counts:", j.get("counts"))
print("trades:", j.get("backtest", {}).get("all"))
print("byType:", json.dumps(j.get("backtest", {}).get("byType", {}), ensure_ascii=False))
print("signals:", len(j.get("signals") or []))
