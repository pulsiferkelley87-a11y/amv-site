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
    empty_streak = 0
    while pn <= 100:
        params = {"pn": pn, "pz": 100, "po": 1, "np": 1, "fltt": 2,
                  "invt": 2, "fid": fid, "fs": fs, "fields": fields}
        data = em_get(params)
        if not data or not data.get("diff"):
            empty_streak += 1
            if empty_streak >= 3:
                break
            time.sleep(3)
            continue
        empty_streak = 0
        diff = data["diff"]
        if isinstance(diff, dict):
            diff = [diff]
        rows.extend(diff)
        if len(rows) >= data.get("total", 0) or len(diff) < 100:
            break
        pn += 1
        time.sleep(0.5)
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


STYLE_NAMES = [
    "百元股", "近期新高", "百日新高", "大盘股", "中盘股", "小盘股", "微盘股",
    "低价股", "破净股", "高股息", "红利", "次新股", "ST股", "举牌", "壳资源",
    "高市盈率", "低市盈率", "绩优股", "亏损股", "扭亏", "预盈预增", "科技",
]


def fetch_styles():
    """东财风格板块快照（按名称白名单筛选）。"""
    fields = "f12,f14,f3,f6,f8,f104,f105"
    rows = em_paginate("m:90+t:3", fields)
    out = []
    for x in rows:
        try:
            name = x["f14"]
        except KeyError:
            continue
        if name not in STYLE_NAMES:
            continue
        out.append({
            "code": x["f12"], "name": name, "pct": x.get("f3"),
            "amount": x.get("f6"), "turnover": x.get("f8"),
            "up": x.get("f104"), "down": x.get("f105"),
        })
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


def fetch_kline_em(code, lmt=500):
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


def fetch_kline_tx(code, lmt=500):
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
        # 量纲校验放宽（腾讯数据股本变化时量纲漂移，0.1~10 倍均可接受）
        ratio = (kl[-1]["amount"] or 0) / (spot_amount or 1)
        if not (0.1 <= ratio <= 10.0):
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
    # chunks 后备（打包上传的批量数据）
    for ch in _load_chunk_map().values():
        if code in ch:
            return ch[code]
    return None


_chunk_index = None


def _load_chunk_map():
    global _chunk_index
    if _chunk_index is None:
        _chunk_index = {}
        for ch_dir_name in ("kline_chunks_v2", "kline_chunks"):
            ch_dir = os.path.join(DATA_DIR, ch_dir_name)
            if os.path.isdir(ch_dir):
                for fn in os.listdir(ch_dir):
                    if fn.startswith("part_") and fn.endswith(".json"):
                        try:
                            with open(os.path.join(ch_dir, fn), encoding="utf-8") as f:
                                _chunk_index[ch_dir_name + "/" + fn] = json.load(f)
                        except (OSError, ValueError):
                            pass
    return _chunk_index


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
        t = rows[i].get("turnover")
        alpha = min(t / 110.0, 1.0) if t and t > 0 else 0.0
        y.append(alpha * x[i] + (1 - alpha) * y[-1])
    return y[-1], [k["date"] for k in rows], y


def load_mv_map(spot):
    """流通市值映射：优先本地 stock_list（新浪口径，亿元->元），否则 spot 快照。"""
    mv_map = {}
    for lst_path in (os.path.join(DATA_DIR, "stock_list.json"),
                     os.path.join(BASE, "stock_list.json")):
        if os.path.exists(lst_path):
            try:
                with open(lst_path, encoding="utf-8") as f:
                    for x in json.load(f):
                        c = x.get("code") or ""
                        if c.startswith(("sh", "sz", "bj")):
                            c = c[2:]
                        try:
                            ltsz = float(x.get("ltsz") or 0)
                        except (TypeError, ValueError):
                            ltsz = 0
                        if c and ltsz:
                            mv_map[c] = ltsz * 1e8
            except (OSError, ValueError):
                mv_map = {}
        if mv_map:
            break
    if not mv_map:
        for s in spot:
            if s.get("float_mv"):
                mv_map[s["code"]] = s["float_mv"]
    return mv_map


def compute_market_amv(official_dates):
    """逐股递推汇总序列（实测版：相关 0.9983 vs 官方 0AMV）。
    每只股票：A_t = D*A_{t-1} + min(t/1.1,1)*(1-A_{t-1})，D=0.5^(1.25/10)，活跃SZ=流通市值*A。"""
    mv_map = load_mv_map([])
    if not mv_map:
        return None
    D = 0.5 ** (1.25 / 10.0)
    date_set = set(official_dates)
    sum_lamv = {}

    def process(code, cache):
        rows = cache.get("rows") or []
        mv_now = mv_map.get(code) or 0
        if len(rows) < 60 or not mv_now:
            return
        closes = [k.get("close") or 0.0 for k in rows]
        if closes[-1] <= 0:
            return
        fac = cache.get("factors")
        fmap = None
        if fac:
            ev = sorted(fac.items())
            fmap = {}
            cur = 1.0
            ei = 0
            for k in rows:
                while ei < len(ev) and ev[ei][0] <= k["date"]:
                    cur = ev[ei][1]
                    ei += 1
                fmap[k["date"]] = cur
            f_last = fmap[rows[-1]["date"]]
        else:
            f_last = 1.0
        A = None
        for i, k in enumerate(rows):
            t = k.get("turnover")
            if t is None:
                mv_t = mv_now * (closes[i] / closes[-1]) if closes[-1] else mv_now
                if fmap is not None:
                    mv_t *= fmap[k["date"]] / f_last
                t = (k["amount"] / mv_t * 100) if mv_t else 0.0
            t = t / 100.0
            a = min(t / 1.1, 1.0)
            A = a if A is None else D * A + a * (1.0 - A)
            mv_t = mv_now * (closes[i] / closes[-1]) if closes[-1] else mv_now
            if fmap is not None:
                mv_t *= fmap[k["date"]] / f_last
            d = k["date"]
            if d in date_set:
                sum_lamv[d] = sum_lamv.get(d, 0.0) + mv_t * A

    seen = set()
    if os.path.isdir(KLINE_DIR):
        for fn in os.listdir(KLINE_DIR):
            if not fn.endswith(".json"):
                continue
            code = fn[:-5]
            seen.add(code)
            try:
                with open(os.path.join(KLINE_DIR, fn), encoding="utf-8") as f:
                    process(code, json.load(f))
            except (OSError, ValueError):
                continue
    for ch in _load_chunk_map().values():
        for code, cache in ch.items():
            if code in seen:
                continue
            seen.add(code)
            process(code, cache)
    out_dates, out_vals = [], []
    for d in official_dates:
        if d in sum_lamv:
            out_dates.append(d)
            out_vals.append(round(sum_lamv[d], 2))
    return {"date": out_dates, "amv": out_vals}


def compute_stock_amv_reg(rows, float_mv):
    """递推活跃度模型（报告版参数：D=0.5^(1.15/10)，激活率=换手率/1.1）。
    活跃SZ = 流通市值 × 活跃度递推。"""
    n = len(rows)
    amt = [k["amount"] for k in rows]
    closes = []
    for k in rows:
        c = k.get("close") or 0.0
        if c <= 0 and k.get("volume"):
            c = k["amount"] / k["volume"] if k["volume"] > 0 else 0.0
        closes.append(c)
    turns = [k.get("turnover") for k in rows]
    if n < 60 or sum(amt[-20:]) <= 0 or not float_mv or closes[-1] <= 0:
        return None, None, None
    mv_now = float_mv
    D = 0.5 ** (1.25 / 10.0)
    series = []
    A = None
    for i in range(n):
        t = turns[i]
        if t is None:
            mv_t = mv_now * (closes[i] / closes[-1]) if closes[-1] else mv_now
            t = (amt[i] / mv_t * 100) if mv_t else 0.0
        t = t / 100.0
        a = min(t / 1.1, 1.0)
        A = a if A is None else D * A + a * (1.0 - A)
        mv_t = mv_now * (closes[i] / closes[-1])
        series.append(max(mv_t * A, 0.0))
    final = series[-1] if series else None
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
    return {
        "date": dates, "var1": var1, "c5": c5, "c13": c13, "c34": c34,
        "cinf": cinf, "turn": turn,
    }


def compute_picks():
    """方向 A：活跃度拐头。A 上穿自身 10 日均线（昨日在均线下，今日站上）。"""
    mv_map = load_mv_map([])
    if not mv_map:
        return []
    name_map = {}
    for lst_path in (os.path.join(DATA_DIR, "stock_list.json"),
                     os.path.join(BASE, "stock_list.json")):
        if os.path.exists(lst_path):
            try:
                with open(lst_path, encoding="utf-8") as f:
                    for x in json.load(f):
                        c = x.get("code") or ""
                        if c.startswith(("sh", "sz", "bj")):
                            c = c[2:]
                        if c and x.get("name"):
                            name_map[c] = x["name"]
            except (OSError, ValueError):
                pass
            break
    D = 0.5 ** (1.25 / 10.0)
    picks = []

    def analyze(code, cache, mv_now):
        rows = cache.get("rows") or []
        if len(rows) < 70 or not mv_now:
            return
        closes = [k.get("close") or 0.0 for k in rows]
        if closes[-1] <= 0:
            return
        fac = cache.get("factors")
        fmap = None
        if fac:
            ev = sorted(fac.items())
            fmap = {}
            cur = 1.0
            ei = 0
            for k in rows:
                while ei < len(ev) and ev[ei][0] <= k["date"]:
                    cur = ev[ei][1]
                    ei += 1
                fmap[k["date"]] = cur
            f_last = fmap[rows[-1]["date"]]
        else:
            f_last = 1.0
        A = None
        A_list = []
        for i, k in enumerate(rows):
            t = k.get("turnover")
            if t is None:
                mv_t = mv_now * (closes[i] / closes[-1]) if closes[-1] else mv_now
                if fmap is not None:
                    mv_t *= fmap[k["date"]] / f_last
                t = (k["amount"] / mv_t * 100) if mv_t else 0.0
            t = t / 100.0
            a = min(t / 1.1, 1.0)
            A = a if A is None else D * A + a * (1.0 - A)
            A_list.append(A)
        if len(A_list) < 12:
            return
        ma = sum(A_list[-11:-1]) / 10.0  # 昨日及之前 10 日均值
        ma_today = (sum(A_list[-10:])) / 10.0  # 今日 10 日均值
        prev_a, cur_a = A_list[-2], A_list[-1]
        prev_ma = ma
        if not (cur_a > ma_today and prev_a <= prev_ma):
            return
        name = name_map.get(code, code)
        if "ST" in name.upper() or "退" in name:
            return
        amt_today = rows[-1].get("amount") or 0
        if amt_today <= 0:
            return
        mv_t_last = mv_now * (closes[-1] / closes[-1])
        # 连续上升天数
        up = 1
        for j in range(len(A_list) - 2, -1, -1):
            if A_list[j + 1] > A_list[j]:
                up += 1
            else:
                break
        picks.append({
            "code": code, "name": name,
            "date": rows[-1]["date"],
            "A": round(cur_a, 4), "ma": round(ma_today, 4),
            "gap": round((cur_a / ma_today - 1) * 100, 2) if ma_today else None,
            "amv": round(mv_t_last * cur_a, 2),
            "amount": amt_today,
            "up_days": up,
        })

    seen = set()
    if os.path.isdir(KLINE_DIR):
        for fn in os.listdir(KLINE_DIR):
            if not fn.endswith(".json"):
                continue
            code = fn[:-5]
            seen.add(code)
            try:
                with open(os.path.join(KLINE_DIR, fn), encoding="utf-8") as f:
                    analyze(code, json.load(f), mv_map.get(code) or 0)
            except (OSError, ValueError):
                continue
    for ch in _load_chunk_map().values():
        for code, cache in ch.items():
            if code in seen:
                continue
            seen.add(code)
            analyze(code, cache, mv_map.get(code) or 0)
    picks.sort(key=lambda x: -x["amv"])
    return picks


def main():
    result = {"updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "errors": []}

    # 1) 官方序列
    official = load_official()
    if not official:
        result["errors"].append("official csv missing")

    # 2) 快照
    spot = fetch_spot()
    sectors = fetch_sectors()
    styles = fetch_styles()
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
    if styles:
        for s in styles:
            s["amount"] = num(s.get("amount"))
            s["pct"] = num(s.get("pct"))
            s["turnover"] = num(s.get("turnover"))
        tot_s = sum(s["amount"] for s in styles if s.get("amount")) or 1
        for s in styles:
            s["amount_pct"] = round((s.get("amount") or 0) / tot_s * 100, 2)
        result["styles"] = sorted(styles, key=lambda x: -(x.get("amount") or 0))

    # 3) 官方序列 + 自研指标
    if official:
        amv_series = [r["amv"] for r in official]

        def _ma(seq, w):
            out = [None] * len(seq)
            s = 0.0
            for i, v in enumerate(seq):
                s += v
                if i >= w:
                    s -= seq[i - w]
                if i >= w - 1:
                    out[i] = round(s / w, 2)
            return out

        ma10_full = _ma(amv_series, 10)
        ma80_full = _ma(amv_series, 80)
        drop_events = []
        for i in range(1, len(amv_series)):
            chg = (amv_series[i] / amv_series[i - 1] - 1) * 100
            if chg <= -2.3:
                drop_events.append({"date": official[i]["date"], "chg": round(chg, 2)})
        result["official"] = {
            "date": [r["date"] for r in official],
            "amv": [r["amv"] for r in official],
            "znz0": [r["znz0"] for r in official],
            "amount": [r["amount"] for r in official],
            "dmv": [r["znz0"] - r["amv"] for r in official],
            "ratio": [r["amv"] / r["znz0"] for r in official],
            "ma10": ma10_full,
            "ma80": ma80_full,
        }
        result["drop_events"] = drop_events
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
        result["self"] = ind

    # 4) 逐股递推口径（实测版，相关 0.9983）：每日增量拉取 + 全市场汇总
    amv_rows, amv_total, day_map = [], 0.0, {}
    if spot:
        # 数据已全量在仓库 chunks 里，云端每日只拉新上市股票（不重拉已有，避免旧数据覆盖新数据包）
        t_fetch_start = time.time()
        uncached = [s for s in spot if not load_cache(s["code"])]
        uncached.sort(key=lambda x: -(x.get("amount") or 0))
        fetch_list = uncached[:100]
        seen = set()
        fetch_list = [s for s in fetch_list if not (s["code"] in seen or seen.add(s["code"]))]
        for idx, s in enumerate(fetch_list):
            if time.time() - t_fetch_start > 1200:
                print("  fetch time budget reached, break", flush=True)
                break
            kl = load_cache(s["code"])
            if kl:
                kl = kl.get("rows")
            else:
                kl, _ = fetch_kline(s["code"], spot_amount=s.get("amount"), float_mv=s.get("float_mv"))
                if kl:
                    save_cache(s["code"], kl)
                time.sleep(0.1)
            if kl:
                amv_r, kdates_r, kseries_r = compute_stock_amv_reg(kl, s.get("float_mv"))
                if amv_r:
                    row = {
                        "code": s["code"], "name": s["name"], "industry": s.get("industry"),
                        "amount": s.get("amount"), "float_mv": s.get("float_mv"),
                        "turnover": s.get("turnover"), "pct": s.get("pct"),
                        "amount_pct": s.get("amount_pct"), "amv": amv_r,
                    }
                    amv_rows.append(row)
                    amv_total += amv_r
                    for i in range(max(0, len(kl) - 250), len(kl)):
                        d = kl[i]["date"]
                        day = day_map.setdefault(d, {"stocks": [], "sector_amv": {}})
                        rec = {
                            "code": s["code"], "name": s["name"], "industry": s.get("industry"),
                            "amount": kl[i].get("amount"), "turnover": kl[i].get("turnover"),
                            "amv": kseries_r[i] if i < len(kseries_r) and kseries_r[i] is not None else None,
                        }
                        day["stocks"].append(rec)
                        ind = s.get("industry") or "—"
                        if rec.get("amv"):
                            day["sector_amv"][ind] = day["sector_amv"].get(ind, 0.0) + rec["amv"]
            if idx % 50 == 49:
                print(f"  amv progress {idx+1} done={len(amv_rows)}", flush=True)
        amv_total = amv_total or 1
        for r in amv_rows:
            r["amv_pct"] = round(r["amv"] / amv_total * 100, 2)
        amv_rows.sort(key=lambda x: -x["amv"])
        sec_map = {}
        for r in amv_rows:
            ind = r.get("industry") or "—"
            sec_map[ind] = sec_map.get(ind, 0.0) + r["amv"]
        sectors_amv = [{"name": k, "amv": v} for k, v in sec_map.items()]
        sectors_amv.sort(key=lambda x: -x["amv"])
        sec_total = sum(x["amv"] for x in sectors_amv) or 1
        for x in sectors_amv:
            x["amv_pct"] = round(x["amv"] / sec_total * 100, 2)
        result["stocks_amv"] = amv_rows
        result["sectors_amv"] = sectors_amv
        result["amv_covered"] = len(amv_rows)
        result["amv_updated_at"] = result["updated_at"]
        history_snaps = {}
        for d, day in day_map.items():
            stocks_d = sorted(day["stocks"], key=lambda x: -(x["amount"] or 0))[:50]
            tot_amt = sum(x["amount"] or 0 for x in day["stocks"]) or 1
            amv_tot = sum(x["amv"] or 0 for x in day["stocks"]) or 1
            for x in stocks_d:
                x["amount_pct"] = round((x["amount"] or 0) / tot_amt * 100, 2)
                if x["amv"]:
                    x["amv_pct"] = round(x["amv"] / amv_tot * 100, 2)
            secs = sorted(day["sector_amv"].items(), key=lambda kv: -kv[1])[:20]
            sec_tot = sum(v for _, v in secs) or 1
            history_snaps[d] = {
                "stocks": stocks_d,
                "sectors": [
                    {"name": k, "amv": v, "amv_pct": round(v / sec_tot * 100, 2)}
                    for k, v in secs
                ],
            }
        result["history_snaps"] = history_snaps

    # 5) 全市场递推汇总序列（历史序列 + 新算尾部合并）
    if official:
        off_dates = [r["date"] for r in official]
        mk = compute_market_amv(off_dates)
        if mk and mk["date"]:
            om = {r["date"]: r["amv"] for r in official}
            common = [(d, v) for d, v in zip(mk["date"], mk["amv"]) if d in om]
            s = om[common[-1][0]] / common[-1][1] if common and common[-1][1] else None
            hist = None
            hp = os.path.join(DATA_DIR, "amv_hist.json")
            if os.path.exists(hp):
                try:
                    with open(hp, encoding="utf-8") as f:
                        hist = json.load(f)
                except (OSError, ValueError):
                    hist = None
            if hist and hist.get("date") and s:
                cutoff = hist["date"][-1]
                i = 0
                while i < len(mk["date"]) and mk["date"][i] <= cutoff:
                    i += 1
                combined = {
                    "date": hist["date"] + mk["date"][i:],
                    "amv": [round(v, 2) for v in hist["amv"]] +
                           [round(v * s, 2) for v in mk["amv"][i:]],
                }
                mk = combined
            elif s:
                mk["amv"] = [round(v * s, 2) for v in mk["amv"]]
                mk["scale"] = round(s, 6)
            result["amv_perstock"] = mk

    # 6) 选股：方向 A 活跃度拐头
    result["picks"] = compute_picks()
    result["picks_updated_at"] = result["updated_at"]

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    with open(APP_JS, "w", encoding="utf-8") as f:
        f.write("var DATA = " + json.dumps(result, ensure_ascii=False) + ";\n")
    print("OK", result["updated_at"], "spot:", len(spot), "sectors:", len(sectors),
          "official:", len(official) if official else 0, "amv:", len(amv_rows))


if __name__ == "__main__":
    main()
