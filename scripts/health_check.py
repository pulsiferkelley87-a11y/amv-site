# -*- coding: utf-8 -*-
"""health_check.py - 数据源健康度轻量检查（独立于主更新，几秒完成）。

三源连通性测试（各拉一只代表股日线）+ 交叉验证（12 只代表股：东财单只 vs tdxhub）。
输出 health.json（前端轮询读取，实现"随时能看、随时更新"）。

设计约束：任何失败不中断（部署工作流 || echo 兜底）；单源失败只记录不抛出。
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import tdxhub
    TDX_AVAILABLE = True
except Exception:
    tdxhub = None
    TDX_AVAILABLE = False

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "health.json")

# 代表股（覆盖沪/深 + 大盘/成长/金融/消费）
PROBE_STOCKS = [
    ("600519", "贵州茅台", "1"),
    ("000001", "平安银行", "0"),
    ("300750", "宁德时代", "0"),
    ("601318", "中国平安", "1"),
    ("000858", "五粮液", "0"),
    ("002594", "比亚迪", "0"),
    ("688981", "中芯国际", "1"),
    ("600036", "招商银行", "1"),
    ("000333", "美的集团", "0"),
    ("002415", "海康威视", "0"),
    ("600900", "长江电力", "1"),
    ("601899", "紫金矿业", "1"),
]

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"}


def probe_em():
    """东财：单只股票实时接口（f43 价格、f48 成交额）。"""
    t0 = time.time()
    try:
        r = requests.get(
            "https://push2.eastmoney.com/api/qt/stock/get",
            params={"secid": "1.600519", "fltt": 2, "fields": "f43,f48,f57"},
            headers=UA, timeout=10,
        )
        j = r.json()
        d = j.get("data") or {}
        ok = bool(d.get("f43") and d.get("f48"))
        return {"ok": ok, "latency_ms": int((time.time() - t0) * 1000)}
    except Exception:
        return {"ok": False, "latency_ms": int((time.time() - t0) * 1000)}


def probe_tx():
    """腾讯：单只日线接口。"""
    t0 = time.time()
    try:
        r = requests.get(
            "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
            params={"param": "sh600519,day,,,2,"}, headers=UA, timeout=10,
        )
        j = r.json()
        day = (j.get("data") or {}).get("sh600519", {}).get("day") or []
        return {"ok": bool(day), "latency_ms": int((time.time() - t0) * 1000)}
    except Exception:
        return {"ok": False, "latency_ms": int((time.time() - t0) * 1000)}


def probe_tdx():
    """通达信 TQLEX：单只日线。"""
    t0 = time.time()
    if not TDX_AVAILABLE:
        return {"ok": False, "latency_ms": 0, "note": "unavailable"}
    try:
        rows = tdxhub.kline_daily("600519", "1", want_num=2)
        return {"ok": bool(rows), "latency_ms": int((time.time() - t0) * 1000)}
    except Exception:
        return {"ok": False, "latency_ms": int((time.time() - t0) * 1000)}


def em_stock(code, setcode):
    """东财单只：返回 (price, amount)。"""
    secid = ("1." if setcode == "1" else "0.") + code
    try:
        r = requests.get(
            "https://push2.eastmoney.com/api/qt/stock/get",
            params={"secid": secid, "fltt": 2, "fields": "f43,f48"},
            headers=UA, timeout=10,
        )
        d = (r.json().get("data") or {})
        price = d.get("f43")
        amt = d.get("f48")
        if price in (None, "-") or amt in (None, "-"):
            return None, None
        return float(price), float(amt)
    except Exception:
        return None, None


def cross_check():
    """12 只代表股：东财 vs tdxhub。价格偏 >1.5% 或额偏 >25% 记 mismatch。"""
    if not TDX_AVAILABLE:
        return {"checked": 0, "matched": 0, "mismatches": [],
                "note": "tdxhub unavailable"}
    out = {"checked": 0, "matched": 0, "mismatches": []}
    for code, name, setcode in PROBE_STOCKS:
        try:
            q = tdxhub.quotes(code, setcode)
            hq = q.get("HQInfo") or {}
            now, amt = hq.get("Now"), hq.get("Amount")
            if not now or not amt:
                continue
            em_price, em_amt = em_stock(code, setcode)
            if not em_price or not em_amt:
                continue
            out["checked"] += 1
            dev_p = abs(now / em_price - 1) * 100
            dev_a = abs(amt / em_amt - 1) * 100
            if dev_p > 1.5 or dev_a > 25:
                out["mismatches"].append({
                    "code": code, "name": name,
                    "em_price": round(em_price, 2), "tdx_price": round(float(now), 2),
                    "dev_pct": round(dev_p, 2),
                    "em_amount": em_amt, "tdx_amount": float(amt),
                    "dev_amt_pct": round(dev_a, 2),
                })
            else:
                out["matched"] += 1
        except Exception:
            continue
    return out


def main():
    bj = datetime.utcnow() + timedelta(hours=8)
    result = {
        "updated_at": bj.strftime("%Y-%m-%d %H:%M:%S"),
        "sources": {
            "em": probe_em(),
            "tdx": probe_tdx(),
            "tx": probe_tx(),
        },
        "cross_check": cross_check(),
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    s = result["sources"]
    print("health:", result["updated_at"],
          "em=%s(%sms)" % (s["em"]["ok"], s["em"]["latency_ms"]),
          "tdx=%s(%sms)" % (s["tdx"]["ok"], s["tdx"]["latency_ms"]),
          "tx=%s(%sms)" % (s["tx"]["ok"], s["tx"]["latency_ms"]),
          "cross:", result["cross_check"]["checked"],
          "/", result["cross_check"]["matched"])


if __name__ == "__main__":
    main()
