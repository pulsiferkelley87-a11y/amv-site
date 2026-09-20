# -*- coding: utf-8 -*-
"""云端版每日更新（GitHub Actions 运行）。

- 官方 0AMV / 0号指数：读仓库内 CSV（由用户电脑每天推送）
- 板块/个股快照、板块成分、DMA 日线：云端直连东财（备选腾讯）
- 生成 app-data.js + data.json，供 GitHub Pages 直接展示
"""
import json
import os
import time
from datetime import datetime, date

import requests

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE, "data")
KLINE_DIR = os.path.join(DATA_DIR, "kline")
OFF_AMV_CSV = os.path.join(DATA_DIR, "official_0amv.csv")
OFF_ZNZ_CSV = os.path.join(DATA_DIR, "official_znz0.csv")
OUT_JSON = os.path.join(DATA_DIR, "data.json")
APP_JS = os.path.join(BASE, "app-data.js")

EM_CLIST = "https://push2.eastmoney.com/api/qt/clist/get"
EM_HOSTS = [
    "https://push2.eastmoney.com/api/qt/clist/get",
    "https://push2delay.eastmoney.com/api/qt/clist/get",
    "https://82.push2.eastmoney.com/api/qt/clist/get",
]
KLINE_HOSTS = [
    "https://push2his.eastmoney.com/api/qt/stock/kline/get",
    "https://push2delay.eastmoney.com/api/qt/stock/kline/get",
    "https://92.push2his.eastmoney.com/api/qt/stock/kline/get",
]

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
    "Referer": "https://quote.eastmoney.com/",
})


def em_get(params, retries=3):
    for _ in range(retries):
        for host in EM_HOSTS:
            try:
                r = session.get(host, params=params, timeout=20)
                if r.status_code == 200:
                    j = r.json()
                    if j.get("data"):
                        return j["data"]
            except Exception:
                time.sleep(1)
        time.sleep(2)
    return None


def em_paginate(fs, fields, fid="f6"):
    rows, pn = [], 1
    while pn <= 100:
        params = {"pn": pn, "pz": 100, "po": 1, "np": 1, "fltt": 2,
                  "invt": 2, "fid": fid, "fs": fs, "fields": fields}
        data = em_get(params)
        if not data or not data.get("diff"):
            break
        diff = data["diff"]
        if isinstance(diff, dict):
            diff = [diff]
        rows.extend(diff)
        if len(rows) >= data.get("total", 0) or len(diff) < 100:
            break
        pn += 1
        time.sleep(0.3)
    return rows


def fetch_spot():
    fs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
    fields = "f12,f14,f2,f3,f5,f6,f8,f20,f21,f100"
    rows = em_paginate(fs, fields)
    out = []
    for x in rows:
        try:
            out.append({
                "code": x["f12"], "name": x["f14"], "price": x.get("f2"),
                "pct": x.get("f3"), "volume": x.get("f5"), "amount": x.get("f6"),
                "turnover": x.get("f8"), "total_mv": x.get("f20"),
                "float_mv": x.get("f21"), "industry": x.get("f100"),
            })
        except KeyError:
            continue
    return out


def fetch_sectors():
    fields = "f12,f14,f3,f6,f8,f20,f104,f105,f128,f140"
    rows = em_paginate("m:90+t:2+f:!50", fields)
    out = []
    for x in rows:
        try:
            out.append({
                "code": x["f12"], "name": x["f14"], "pct": x.get("f3"),
                "amount": x.get("f6"), "turnover": x.get("f8"), "mv": x.get("f20"),
                "up": x.get("f104"), "down": x.get("f105"),
                "leader": x.get("f128"), "leader_pct": x.get("f140"),
            })
        except KeyError:
            continue
    return out


def fetch_sector_members(sectors, top_n=50):
    mapping = {}
    for sec in sectors[:top_n]:
        code = sec.get("code")
        if not code:
            continue
        rows = em_paginate(f"b:{code}", "f12")
        mapping[sec["name"]] = [x["f12"] for x in rows]
        time.sleep(0.25)
    return mapping


def fetch_kline_em(code, lmt=250):
    if code.startswith("6"):
        secid = "1." + code
    elif code.startswith(("0", "3", "4", "8", "9")):
        secid = "0." + code
    else:
        return None
    params = {
        "secid": secid, "klt": 101, "fqt": 0, "lmt": lmt, "end": 20500101,
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    }
    for host in KLINE_HOSTS:
        try:
            r = session.get(host, params=params, timeout=15)
            j = r.json()
            klines = (j.get("data") or {}).get("klines") or []
            out = []
            for line in klines:
                p = line.split(",")
                if len(p) < 11:
                    continue
                out.append({
                    "date": p[0],
                    "close": float(p[2]) if p[2] not in ("", "-") else 0.0,
                    "amount": float(p[6]) if p[6] not in ("", "-") else 0.0,
                    "volume": float(p[5]) if p[5] not in ("", "-") else 0.0,
                    "turnover": float(p[10]) if p[10] not in ("", "-") else None,
                })
            if out:
                return out
        except Exception:
            continue
    return None


def fetch_kline_tx(code, lmt=250):
    prefix = "sh" if code.startswith("6") else ("sz" if code.startswith(("0", "3")) else None)
    if not prefix:
        return None
    try:
        r = session.get(
            "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
            params={"param": f"{prefix}{code},day,,,{lmt},"}, timeout=15,
        )
        j = r.json()
        day = (j.get("data") or {}).get(f"{prefix}{code}", {}).get("day") or []
        out = []
        for row in day:
            try:
                o, c, h, l, v = (float(row[i]) for i in (1, 2, 3, 4, 5))
            except (ValueError, IndexError):
                continue
            avg = (o + h + l + c) / 4
            out.append({"date": row[0], "close": c, "amount": v * 100 * avg,
                        "volume": v * 100, "turnover": None})
        return out if out else None
    except Exception:
        return None


def fetch_kline(code, spot_amount=None, float_mv=None):
    kl = fetch_kline_em(code)
    if kl:
        return kl, "em"
    kl = fetch_kline_tx(code)
    if kl and spot_amount:
        ratio = (kl[-1]["amount"] or 0) / (spot_amount or 1)
        if not (0.2 <= ratio <= 3.0):
            return None, "tx_rejected"
        if float_mv:
            for k in kl:
                k["turnover"] = (k["amount"] / float_mv * 100) if float_mv else None
    return kl, "tx" if kl else None


def load_cache(code):
    p = os.path.join(KLINE_DIR, code + ".json")
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None
    return None


def save_cache(code, rows):
    os.makedirs(KLINE_DIR, exist_ok=True)
    with open(os.path.join(KLINE_DIR, code + ".json"), "w", encoding="utf-8") as f:
        json.dump({"updated": date.today().isoformat(), "rows": rows}, f, ensure_ascii=False)


def sma(x, n):
    y = [x[0]]
    for v in x[1:]:
        y.append((v + (n - 1) * y[-1]) / n)
    return y


def dma(x, alpha):
    y = [x[0]]
    for i in range(1, len(x)):
        y.append(alpha[i] * x[i] + (1 - alpha[i]) * y[i - 1])
    return y


def compute_stock_amv(rows):
    amt = [k["amount"] for k in rows]
    if len(amt) < 60 or sum(amt[-20:]) <= 0:
        return None, None, None
    x = sma(amt, 10)
    y = [x[0]]
    for i in range(1, len(x)):
        t = rows[i]["turnover"]
        alpha = min(t / 110.0, 1.0) if t and t > 0 else 0.0
        y.append(alpha * x[i] + (1 - alpha) * y[-1])
    return y[-1], [k["date"] for k in rows], y


def compute_stock_amv_reg(rows, float_mv):
    """公式口径活跃市值（amv_reg 市场级系数个股延伸）。"""
    n = len(rows)
    amt = [k["amount"] for k in rows]
    closes = []
    for k in rows:
        c = k.get("close") or 0.0
        if c <= 0 and k.get("volume"):
            c = k["amount"] / k["volume"] if k["volume"] > 0 else 0.0
        closes.append(c)
    turns = [k["turnover"] for k in rows]
    if n < 60 or sum(amt[-20:]) <= 0 or not float_mv or closes[-1] <= 0:
        return None, None, None
    mv_now = float_mv
    turn_eff = []
    for i in range(n):
        t = turns[i]
        if t is None:
            mv_t = mv_now * (closes[i] / closes[-1]) if closes[-1] else mv_now
            t = (amt[i] / mv_t * 100) if mv_t else 0.0
        turn_eff.append(t / 100.0)
    st10 = sma(turn_eff, 10)
    st60 = sma(turn_eff, 60)
    st250 = sma(turn_eff, 250)
    cum = [None] * n
    s = 0.0
    for i in range(n):
        s += turn_eff[i]
        if i >= 250:
            s -= turn_eff[i - 250]
        if i >= 249:
            cum[i] = s
    series = []
    for i in range(n):
        if cum[i] is None or closes[i - 250] <= 0:
            series.append(None)
            continue
        ret250 = closes[i] / closes[i - 250] - 1
        vt = st60[i] / st250[i] if st250[i] > 0 else 0.0
        r_hat = 0.01537 + 5.830 * st10[i] + 0.00214 * cum[i] + 0.00496 * ret250 + 0.0372 * vt
        mv_t = mv_now * (closes[i] / closes[-1])
        series.append(max(mv_t * r_hat, 0.0))
    final = series[-1] if series and series[-1] is not None else None
    if final is None:
        return None, None, None
    return final, [k["date"] for k in rows], series


def pct_rank(values):
    import bisect
    vals = [v for v in values if v is not None]
    if not vals:
        return [None] * len(values)
    srt = sorted(vals)
    n = len(srt)
    return [round(bisect.bisect_left(srt, v) / n * 100, 1) if v is not None else None for v in values]


def load_official():
    """从仓库 CSV 读官方序列。"""
    import csv as _csv
    try:
        amv_rows = {}
        with open(OFF_AMV_CSV, encoding="utf-8") as f:
            for r in _csv.DictReader(f):
                amv_rows[r["date"]] = (float(r["close"]), float(r["amount"]), float(r["volume"]))
        znz_rows = {}
        with open(OFF_ZNZ_CSV, encoding="utf-8") as f:
            for r in _csv.DictReader(f):
                znz_rows[r["date"]] = float(r["close"])
        dates = sorted(set(amv_rows) & set(znz_rows))
        return [
            {"date": d, "amv": amv_rows[d][0], "znz0": znz_rows[d],
             "amount": amv_rows[d][1], "volume": amv_rows[d][2]}
            for d in dates
        ]
    except (OSError, KeyError):
        return None


def compute_self(official_rows):
    amt = [r["amount"] for r in official_rows]
    z = [r["znz0"] for r in official_rows]
    dates = [r["date"] for r in official_rows]
    n = len(amt)
    for i in range(1, n - 1):
        if amt[i] == 0:
            amt[i] = (amt[i - 1] + amt[i + 1]) / 2
    var1 = [v / 1e7 for v in sma(amt, 10)]
    x5, x13, x34 = sma(var1, 3), sma(var1, 5), sma(var1, 8)
    turn = [amt[i] / (z[i] * 1e8) for i in range(n)]
    c5 = dma(x5, [min(1.0, turn[i] / 0.02) for i in range(n)])
    c13 = dma(x13, [min(1.0, turn[i] / 0.1) for i in range(n)])
    c34 = dma(x34, [min(1.0, turn[i] / 0.18) for i in range(n)])
    cinf = dma(var1, [min(1.0, turn[i] / 1.1) for i in range(n)])
    st10 = sma(turn, 10)
    amv_hat = [z[i] * st10[i] * 9.4 for i in range(n)]
    # 回归拟合版
    amv_reg = []
    st60, st250 = sma(turn, 60), sma(turn, 250)
    cum250 = []
    s = 0.0
    for i in range(n):
        s += turn[i]
        if i >= 250:
            s -= turn[i - 250]
        cum250.append(s if i >= 249 else None)
    for i in range(n):
        if cum250[i] is None or z[i - 250] <= 0:
            amv_reg.append(None)
            continue
        zr = z[i] / z[i - 250] - 1
        vt = st60[i] / st250[i] if st250[i] > 0 else 0.0
        r_hat = 0.01537 + 5.830 * st10[i] + 0.00214 * cum250[i] + 0.00496 * zr + 0.0372 * vt
        amv_reg.append(max(z[i] * r_hat, 0.0))
    return {
        "date": dates, "var1": var1, "c5": c5, "c13": c13, "c34": c34,
        "cinf": cinf, "amv_hat": amv_hat, "amv_reg": amv_reg, "turn": turn,
    }


def main():
    result = {"updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "errors": []}

    # 1) 官方序列
    official = load_official()
    if not official:
        result["errors"].append("official csv missing")

    # 2) 快照
    spot = fetch_spot()
    sectors = fetch_sectors()
    if not spot:
        result["errors"].append("spot fetch failed")
        spot = []
    if not sectors:
        sectors = []

    def num(v):
        try:
            f = float(v)
            return f if f == f and f > 0 else None
        except (TypeError, ValueError):
            return None

    if spot:
        for s in spot:
            s["amount"] = num(s.get("amount"))
            s["float_mv"] = num(s.get("float_mv"))
            s["total_mv"] = num(s.get("total_mv"))
            s["turnover"] = num(s.get("turnover"))
            s["pct"] = num(s.get("pct"))
            s["price"] = num(s.get("price"))
        valid = [s for s in spot if s.get("amount") and s.get("float_mv")]
        tot_amt = sum(s["amount"] for s in valid) or 1
        tot_mv = sum(s["float_mv"] for s in valid) or 1
        for s in valid:
            s["amount_pct"] = round(s["amount"] / tot_amt * 100, 2)
            s["mv_pct"] = round(s["float_mv"] / tot_mv * 100, 2)
        pa, pt, pp = pct_rank([s.get("amount") for s in valid]), \
            pct_rank([s.get("turnover") for s in valid]), \
            pct_rank([s.get("pct") for s in valid])
        for s, a, b, c in zip(valid, pa, pt, pp):
            if a is not None and b is not None:
                s["score"] = round((a if a else 50) * 0.5 + (b if b else 50) * 0.3 + (c if c else 50) * 0.2, 1)
        stocks_top = sorted(valid, key=lambda x: -x["amount"])[:80]
        result["stocks_top"] = stocks_top
        all_stocks = [
            {"code": s["code"], "name": s["name"], "amount": s["amount"],
             "float_mv": s["float_mv"], "turnover": s["turnover"], "pct": s["pct"],
             "industry": s.get("industry"), "amount_pct": s["amount_pct"],
             "score": s.get("score")}
            for s in valid
        ]
        result["all_stocks"] = all_stocks
        result["market_totals"] = {"amount": tot_amt, "float_mv": tot_mv, "count": len(valid)}

    if sectors:
        for s in sectors:
            s["amount"] = num(s.get("amount"))
            s["mv"] = num(s.get("mv"))
            s["pct"] = num(s.get("pct"))
            s["turnover"] = num(s.get("turnover"))
        tot_s = sum(s["amount"] for s in sectors if s.get("amount")) or 1
        for s in sectors:
            s["amount_pct"] = round((s.get("amount") or 0) / tot_s * 100, 2)
        pa, pt, pp = pct_rank([s.get("amount") for s in sectors]), \
            pct_rank([s.get("turnover") for s in sectors]), \
            pct_rank([s.get("pct") for s in sectors])
        for s, a, b, c in zip(sectors, pa, pt, pp):
            s["score"] = round((a if a else 50) * 0.5 + (b if b else 50) * 0.3 + (c if c else 50) * 0.2, 1)
        result["sectors"] = sorted(sectors, key=lambda x: -(x.get("amount") or 0))
        result["sector_members"] = fetch_sector_members(result["sectors"], top_n=50)

    # 3) 官方序列 + 自研指标
    if official:
        result["official"] = {
            "date": [r["date"] for r in official][-500:],
            "amv": [r["amv"] for r in official][-500:],
            "znz0": [r["znz0"] for r in official][-500:],
            "amount": [r["amount"] for r in official][-500:],
            "dmv": [r["znz0"] - r["amv"] for r in official][-500:],
            "ratio": [r["amv"] / r["znz0"] for r in official][-500:],
        }
        result["official_full"] = {
            "date": [r["date"] for r in official],
            "amv": [r["amv"] for r in official],
            "znz0": [r["znz0"] for r in official],
            "ratio": [r["amv"] / r["znz0"] for r in official],
        }
        w = official[::5]
        result["official_weekly"] = {
            "date": [r["date"] for r in w],
            "amv": [r["amv"] for r in w],
            "znz0": [r["znz0"] for r in w],
            "ratio": [r["amv"] / r["znz0"] for r in w],
        }
        ind = compute_self(official)
        result["self"] = {k: v[-500:] for k, v in ind.items()}

    # 4) DMA + 公式口径（云端不限量，全量 300，缓存持久化到 repo）
    dma_rows, reg_rows, dma_total, day_map = [], [], 0.0, {}
    if spot:
        top300 = sorted(spot, key=lambda x: -(x.get("amount") or 0))[:300]
        for idx, s in enumerate(top300):
            kl = load_cache(s["code"])
            if kl:
                kl = kl.get("rows")
            else:
                kl, _ = fetch_kline(s["code"], spot_amount=s.get("amount"), float_mv=s.get("float_mv"))
                if kl:
                    save_cache(s["code"], kl)
                time.sleep(0.3)
            if kl:
                amv, kdates, kseries = compute_stock_amv(kl)
                amv_r, kdates_r, kseries_r = compute_stock_amv_reg(kl, s.get("float_mv"))
                if amv:
                    row = {
                        "code": s["code"], "name": s["name"], "industry": s.get("industry"),
                        "amount": s.get("amount"), "float_mv": s.get("float_mv"),
                        "turnover": s.get("turnover"), "pct": s.get("pct"),
                        "amount_pct": s.get("amount_pct"), "amv_dma": amv,
                    }
                    if amv_r:
                        row["amv_reg"] = amv_r
                    dma_rows.append(row)
                    dma_total += amv
                    for i in range(max(0, len(kl) - 250), len(kl)):
                        d = kl[i]["date"]
                        day = day_map.setdefault(d, {"stocks": [], "sector_amt": {}, "sector_reg": {}})
                        rec = {
                            "code": s["code"], "name": s["name"], "industry": s.get("industry"),
                            "amount": kl[i]["amount"], "turnover": kl[i]["turnover"],
                            "amv_dma": kseries[i] if i < len(kseries) else None,
                        }
                        if kseries_r and i < len(kseries_r) and kseries_r[i] is not None:
                            rec["amv_reg"] = kseries_r[i]
                        day["stocks"].append(rec)
                        ind = s.get("industry") or "—"
                        day["sector_amt"][ind] = day["sector_amt"].get(ind, 0.0) + (kl[i]["amount"] or 0.0)
                        if rec.get("amv_reg"):
                            day["sector_reg"][ind] = day["sector_reg"].get(ind, 0.0) + rec["amv_reg"]
            if idx % 50 == 49:
                print(f"  dma progress {idx+1}/300 done={len(dma_rows)}", flush=True)
        dma_total = dma_total or 1
        for r in dma_rows:
            r["amv_dma_pct"] = round(r["amv_dma"] / dma_total * 100, 2)
        dma_rows.sort(key=lambda x: -x["amv_dma"])
        reg_rows = [r for r in dma_rows if r.get("amv_reg")]
        reg_total = sum(r["amv_reg"] for r in reg_rows) or 1
        for r in reg_rows:
            r["amv_reg_pct"] = round(r["amv_reg"] / reg_total * 100, 2)
        reg_rows.sort(key=lambda x: -x["amv_reg"])
        result["stocks_dma"] = dma_rows
        result["stocks_reg"] = reg_rows
        result["dma_covered"] = len(dma_rows)
        result["reg_covered"] = len(reg_rows)
        result["dma_updated_at"] = result["updated_at"]
        history_snaps = {}
        for d, day in day_map.items():
            stocks_d = sorted(day["stocks"], key=lambda x: -(x["amount"] or 0))[:50]
            tot_amt = sum(x["amount"] or 0 for x in day["stocks"]) or 1
            dma_tot = sum(x["amv_dma"] or 0 for x in day["stocks"]) or 1
            reg_tot = sum(x.get("amv_reg") or 0 for x in day["stocks"]) or 1
            for x in stocks_d:
                x["amount_pct"] = round((x["amount"] or 0) / tot_amt * 100, 2)
                if x["amv_dma"]:
                    x["amv_dma_pct"] = round(x["amv_dma"] / dma_tot * 100, 2)
                if x.get("amv_reg"):
                    x["amv_reg_pct"] = round(x["amv_reg"] / reg_tot * 100, 2)
            secs = sorted(day["sector_amt"].items(), key=lambda kv: -kv[1])[:20]
            sec_tot = sum(v for _, v in secs) or 1
            secs_reg = sorted(day["sector_reg"].items(), key=lambda kv: -kv[1])[:20]
            sec_reg_tot = sum(v for _, v in secs_reg) or 1
            history_snaps[d] = {
                "stocks": stocks_d,
                "sectors": [
                    {"name": k, "amount": v, "amount_pct": round(v / sec_tot * 100, 2),
                     "amv_reg": day["sector_reg"].get(k),
                     "amv_reg_pct": round((day["sector_reg"].get(k) or 0) / sec_reg_tot * 100, 2)}
                    for k, v in secs
                ],
            }
        result["history_snaps"] = history_snaps

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    with open(APP_JS, "w", encoding="utf-8") as f:
        f.write("var DATA = " + json.dumps(result, ensure_ascii=False) + ";\n")
    print("OK", result["updated_at"], "spot:", len(spot), "sectors:", len(sectors),
          "official:", len(official) if official else 0, "dma:", len(dma_rows))


if __name__ == "__main__":
    main()
