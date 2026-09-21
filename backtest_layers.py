# -*- coding: utf-8 -*-
"""权重股分层逐股回测：不同样本量下递推汇总与官方 0AMV 的拟合趋势。

分层：按成交额 top N 与 按流通市值 top N 各取 {50,100,150,200,250,333}。
"""
import json
import os
import numpy as np
import pandas as pd

KLINE_DIR = r"F:\小太阳的聊天记录\amv-cloud\data\kline"
CSV = r"F:\小太阳的聊天记录\compass-0amv-output\0amv_daily.csv"
ZNZ = r"F:\小太阳的聊天记录\compass-0amv-output\znz0_daily.csv"

amv = pd.read_csv(CSV)
amv = amv[amv["is_research_row"] == True].reset_index(drop=True)
znz = pd.read_csv(ZNZ)[["date", "close"]]
m = amv.merge(znz, on="date", suffixes=("", "_znz"))
official = m["close"].values.astype(float)
date_series = list(m["date"])

D = json.load(open(r"F:\小太阳的聊天记录\amv-site\site\data\data.json", encoding="utf-8"))
all_stocks = D.get("all_stocks", [])
by_amt = sorted([s for s in all_stocks if s.get("amount")], key=lambda x: -x["amount"])
by_mv = sorted([s for s in all_stocks if s.get("float_mv")], key=lambda x: -x["float_mv"])
mv_map = {s["code"]: (s.get("float_mv") or 0) for s in all_stocks}

decay = 0.5 ** (1.25 / 10.0)


def run_for(codes):
    sum_lamv = {}
    for code in codes:
        fp = os.path.join(KLINE_DIR, code + ".json")
        if not os.path.exists(fp):
            continue
        with open(fp, encoding="utf-8") as f:
            rows = json.load(f).get("rows") or []
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
    scale = np.sum(model * off) / np.sum(model * model)
    corr = np.corrcoef(model, off)[0, 1]
    rmse = np.sqrt(np.mean((model * scale - off) ** 2)) / np.mean(off) * 100
    bias = np.mean(model * scale - off) / np.mean(off) * 100
    return corr, rmse, bias


print("== 按成交额 top N 分层 ==")
print(f"{'N':>6}{'相关':>10}{'RMSE%':>10}{'偏差%':>10}")
for N in [50, 100, 150, 200, 250, 333]:
    corr, rmse, bias = run_for([s["code"] for s in by_amt[:N]])
    print(f"{N:>6}{corr:>10.4f}{rmse:>10.1f}{bias:>+9.1f}%")

print()
print("== 按流通市值 top N 分层 ==")
print(f"{'N':>6}{'相关':>10}{'RMSE%':>10}{'偏差%':>10}")
for N in [50, 100, 150, 200, 250, 333]:
    corr, rmse, bias = run_for([s["code"] for s in by_mv[:N]])
    print(f"{N:>6}{corr:>10.4f}{rmse:>10.1f}{bias:>+9.1f}%")
