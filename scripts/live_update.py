# -*- coding: utf-8 -*-
"""实盘快照：指数 + 全市场个股实时 + 通达信板块聚合 → live_data.json（每 5 分钟由 live.yml 触发）。"""
import json
import time

import requests

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
    "Referer": "https://finance.sina.com.cn/",
})

INDICES = [
    ("s_sh000001", "上证指数"),
    ("s_sz399001", "深证成指"),
    ("s_sz399006", "创业板指"),
    ("s_sh000688", "科创50"),
]


def fetch_indices():
    """腾讯指数快照。"""
    out = []
    try:
        s = requests.Session()
        s.headers.update({"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"})
        codes = ",".join(c for c, _ in INDICES)
        r = s.get(f"https://qt.gtimg.cn/q={codes}", timeout=15)
        r.encoding = "gbk"
        for line in r.text.strip().split(";"):
            line = line.strip()
            if not line or "=" not in line:
                continue
            body = line.split("=", 1)[1].strip('"')
            parts = body.split("~")
            if len(parts) < 5:
                continue
            name = parts[1]
            price = parts[3]
            # 腾讯指数接口已改 12 字段精简版：4=涨跌额，5=涨跌幅，9=成交额(万)
            pct = parts[5] if len(parts) > 5 else "0"
            chg = parts[4] if len(parts) > 4 else "0"
            amt = float(parts[9]) * 10000 if len(parts) > 9 and parts[9] else 0
            out.append({
                "name": name,
                "price": float(price) if price else 0,
                "pct": float(pct) if pct else 0,
                "chg": float(chg) if chg else 0,
                "amount": amt,
            })
    except Exception as e:
        print("indices err:", str(e)[:80])
    return out


def fetch_spot():
    """新浪全市场快照（实时）。慢速分页 + 每页重试，避免限流截断。"""
    rows = []
    for page in range(1, 60):
        got = False
        for attempt in range(4):
            try:
                r = session.get(
                    "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData",
                    params={"page": page, "num": 100, "sort": "symbol", "asc": 1, "node": "hs_a"},
                    timeout=20)
                if r.status_code == 200 and r.text.startswith("["):
                    j = json.loads(r.text)
                    if j:
                        rows.extend(j)
                        got = True
                        if len(j) < 100:
                            break
                        break
            except Exception:
                pass
            time.sleep(0.6)
        if not got and page <= 3:
            # 首页拿不到直接报；后面页面若限流，休息更久再试
            time.sleep(2)
        elif not got:
            time.sleep(1.5)
            continue
        time.sleep(0.35)
    out = []
    for x in rows:
        try:
            out.append({
                "code": x["symbol"],
                "name": x["name"],
                "price": float(x.get("trade") or 0),
                "pct": float(x.get("changepercent") or 0),
                "amount": float(x.get("amount") or 0),
                "turnover": float(x.get("turnoverratio") or 0),
                "float_mv": float(x.get("nmc") or 0),
            })
        except (KeyError, ValueError):
            continue
    return out


def load_blocks():
    try:
        with open("concept_blocks.json", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def aggregate_blocks(stocks):
    smap = {s["code"][2:] if s["code"][:2] in ("sh", "sz", "bj") else s["code"]: s
            for s in stocks}
    blocks = load_blocks()
    out = []
    for b in blocks:
        codes = list(dict.fromkeys(b["stocks"]))
        pcts = []
        amt = 0.0
        n = 0
        for c in codes:
            s = smap.get(c)
            if s:
                pcts.append(s["pct"])
                amt += s["amount"]
                n += 1
        if n < 5:
            continue
        avg = round(sum(pcts) / len(pcts), 2) if pcts else 0.0
        out.append({
            "name": b["name"], "code": b["code"],
            "type": b.get("type", "概念"),
            "pct": avg, "amount": round(amt, 2),
            "n": n, "total": len(codes),
        })
    return out


def main():
    indices = fetch_indices()
    stocks = fetch_spot()
    blocks = aggregate_blocks(stocks)
    # 市场情绪：涨跌家数/涨跌停
    ups = sum(1 for s in stocks if s["pct"] > 0)
    downs = sum(1 for s in stocks if s["pct"] < 0)
    flats = len(stocks) - ups - downs
    limit_up = sum(1 for s in stocks if s["pct"] >= 9.9)
    limit_down = sum(1 for s in stocks if s["pct"] <= -9.9)
    breadth = {
        "up": ups, "down": downs, "flat": flats,
        "limit_up": limit_up, "limit_down": limit_down,
        "total": len(stocks),
    }
    payload = {
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "indices": indices,
        "breadth": breadth,
        "stocks": stocks,
        "blocks": blocks,
    }
    with open("live_data.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"live: indices {len(indices)}, stocks {len(stocks)}, blocks {len(blocks)}, breadth {breadth}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
