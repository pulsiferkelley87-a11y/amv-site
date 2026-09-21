# -*- coding: utf-8 -*-
"""逐股递推公式回测：A_i,t = D*A_i,t-1 + min(t_i/1.1,1)*(1-A_i,t-1)，汇总 vs 官方 0AMV。

数据：data/kline/*.json（云端缓存的个股 250 日日线）+ 当日快照 float_mv。
"""
import json
import os
import sys
import numpy as np
import pandas as pd

KLINE_DIR = r"F:\小太阳的聊天记录\amv-cloud\data\kline"
CSV = r"F:\小太阳的聊天记录\compass-0amv-output\0amv_daily.csv"
ZNZ = r"F:\小太阳的聊天记录\compass-0amv-output\znz0_daily.csv"

amv = pd.read_csv(CSV)
amv = amv[amv["is_research_row"] == True].reset_index(drop=True)
znz = pd.read_csv(ZNZ)[["date", "close"]]
m = amv.merge(znz, on="date", suffixes=("", "_znz"))
z = m["close_znz"].values.astype(float)
official = m["close"].values.astype(float)
date_series = list(m["date"])

data_json = r"F:\小太阳的聊天记录\amv-site\site\data\data.json"
D = json.load(open(data_json, encoding="utf-8"))
mv_map = {s["code"]: (s.get("float_mv") or 0) for s in D.get("all_stocks", [])}

files = [f for f in os.listdir(KLINE_DIR) if f.endswith(".json")]
print(f"kline 文件数: {len(files)}")

decay = 0.5 ** (1.25 / 10.0)
sum_lamv = {}
for fn in files:
    code = fn[:-5]
    with open(os.path.join(KLINE_DIR, fn), encoding="utf-8") as f:
        cache = json.load(f)
    rows = cache.get("rows") or []
    mv_now = mv_map.get(code) or 0
    if len(rows) < 60 or not mv_now:
        continue
    closes = [k.get("close") or 0.0 for k in rows]
    if closes[-1] <= 0:
        continue
    A = None
    for i, k in enumerate(rows):
        t = k.get("turnover")
        if t is None:
            mv_t = mv_now * (closes[i] / closes[-1]) if closes[-1] else mv_now
            t = (k["amount"] / mv_t * 100) if mv_t else 0.0
        t = t / 100.0
        a = min(t / 1.1, 1.0)
        A = a if A is None else decay * A + a * (1.0 - A)
        mv_t = mv_now * (closes[i] / closes[-1]) if closes[-1] else mv_now
        dte = k["date"]
        sum_lamv[dte] = sum_lamv.get(dte, 0.0) + mv_t * A

model = np.array([sum_lamv.get(d, np.nan) for d in date_series])
ok = np.isfinite(model)
model, off = model[ok], official[ok]
dates_ok = np.array(date_series)[ok]

scale = np.sum(model * off) / np.sum(model * model)
corr = np.corrcoef(model, off)[0, 1]
rmse = np.sqrt(np.mean((model * scale - off) ** 2)) / np.mean(off) * 100
print(f"逐股递推汇总 vs 官方 0AMV:")
print(f"  相关: {corr:.4f}  缩放后 RMSE: {rmse:.1f}%")

for label, y0 in [("2021+", "2021-01-01"), ("2024+", "2024-01-01"), ("2025+", "2025-01-01")]:
    mask = dates_ok >= y0
    rm = np.sqrt(np.mean((model[mask] * scale - off[mask]) ** 2)) / np.mean(off[mask]) * 100
    bias = np.mean(model[mask] * scale - off[mask]) / np.mean(off[mask]) * 100
    print(f"  {label}: RMSE={rm:.1f}%  偏差={bias:+.1f}%")
