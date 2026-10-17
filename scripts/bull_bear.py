# -*- coding: utf-8 -*-
"""A股牛熊识别系统：六大模块计算（价格趋势/市场广度/量能/情绪自动，宏观/估值手动）。

产出 bull_bear.json：
{updated_at, scores:{trend,breadth,volume,macro,valuation,sentiment},
 total, state, details:{...每个模块的证据明细}}
"""
import json
import os
import sys
import urllib.request

# tdxhub 备选源（通达信 TQLEX 指数日线）；导入失败则仅用腾讯
TDX_AVAILABLE = False
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import tdxhub as _tdxhub
    TDX_AVAILABLE = True
except Exception:
    pass

# 腾讯指数代码 -> (tdxhub 数字代码, setcode)
TDX_INDEX_MAP = {
    "sh000001": ("000001", "1"),  # 上证指数
    "sh000300": ("000300", "1"),  # 沪深300
    "sz399001": ("399001", "0"),  # 深证成指
    "sz399006": ("399006", "0"),  # 创业板指
    "sh000905": ("000905", "1"),  # 中证500
    "sh000852": ("000852", "1"),  # 中证1000
}

INDICES_BB = [
    ("sh000001", "上证指数"),
    ("sh000300", "沪深300"),
    ("sz399001", "深证成指"),
    ("sz399006", "创业板指"),
    ("sh000905", "中证500"),
    ("sh000852", "中证1000"),
]


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except Exception:
        return -1, ""


def fetch_index_daily(code):
    """指数日线（约 320 根），返回 [(date, close)]。
    腾讯优先；失败或空则 tdxhub（通达信 TQLEX）备选。"""
    rows = _fetch_index_tx(code)
    if not rows and TDX_AVAILABLE:
        rows = _fetch_index_tdx(code)
    return rows


def _fetch_index_tx(code):
    """腾讯指数日线。"""
    url = (f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
           f"?param={code},day,,,320,qfq")
    st, txt = http_get(url)
    if st != 200:
        return []
    try:
        j = json.loads(txt)
        node = j["data"][code]
        rows = node.get("qfqday") or node.get("day") or []
        return [(r[0], float(r[2])) for r in rows if len(r) >= 3]
    except Exception:
        return []


def _fetch_index_tdx(code):
    """tdxhub 指数日线（通达信 TQLEX），返回 [(date, close)]。"""
    t = TDX_INDEX_MAP.get(code)
    if not t:
        return []
    try:
        rows = _tdxhub.kline_daily(t[0], t[1], want_num=320)
        out = []
        for r in rows:
            if not r.get("close"):
                continue
            d = r["date"]
            if len(d) == 8 and d.isdigit():  # 20261012 -> 2026-10-12，与腾讯格式对齐
                d = "%s-%s-%s" % (d[:4], d[4:6], d[6:8])
            out.append((d, r["close"]))
        return out
    except Exception:
        return []


def ma(series, n):
    if len(series) < n:
        return None
    return sum(series[-n:]) / n


def slope(series, n):
    """近 n 日线性斜率（相对百分比）。"""
    if len(series) < n or series[-n] == 0:
        return None
    return (series[-1] / series[-n] - 1) * 100


def score_trend(indices_rows):
    """模块1 价格趋势：指数 vs 均线 + 均线方向 + 回撤。返回 -100~+100。"""
    total = 0.0
    cnt = 0
    details = []
    for code, name in INDICES_BB:
        rows = indices_rows.get(code) or []
        closes = [c for _, c in rows]
        if len(closes) < 120:
            continue
        cur = closes[-1]
        m20, m60, m120, m250 = (ma(closes, 20), ma(closes, 60),
                                ma(closes, 120), ma(closes, 250))
        pts = 0
        if m20 and m60 and m120:
            pts += 40 if cur > m20 else -40
            pts += 25 if cur > m60 else -25
            pts += 20 if cur > m120 else -20
            pts += 15 if (m250 and cur > m250) else (0 if m250 else 0)
            # 均线方向
            if len(closes) >= 260 and m250:
                m250_prev = ma(closes[:-20], 250)
                if m250_prev and m250 > m250_prev:
                    pts += 15
                elif m250_prev:
                    pts -= 15
            # 60日斜率
            s60 = slope(closes, 60)
            if s60 is not None:
                pts += 10 if s60 > 0 else -10
        pts = max(-100, min(100, pts))
        total += pts
        cnt += 1
        details.append({"index": name, "score": round(pts, 1),
                        "close": cur, "ma20": round(m20, 1) if m20 else None,
                        "ma60": round(m60, 1) if m60 else None,
                        "ma250": round(m250, 1) if m250 else None})
    if not cnt:
        return 0, details
    return round(total / cnt, 1), details


def score_breadth(stocks_rows):
    """模块2 市场广度：站上各均线的股票占比。stocks_rows: {code: [closes]}。"""
    counts = {20: 0, 60: 0, 120: 0, 250: 0}
    n = 0
    for code, closes in stocks_rows.items():
        if len(closes) < 20:
            continue
        n += 1
        cur = closes[-1]
        for w in counts:
            m = ma(closes, w)
            if m and cur > m:
                counts[w] += 1
    if not n:
        return 0, {}
    pct = {w: round(counts[w] / n * 100, 1) for w in counts}
    # 打分：站上60/120/250日均线的占比（50%为中性）
    pts = ((pct[60] - 50) * 1.6 + (pct[120] - 50) * 1.2 + (pct[250] - 50) * 0.8) / 3.6
    pts = max(-100, min(100, pts))
    return round(pts, 1), {"n": n, "above_pct": pct}


def score_volume(market_amount_series):
    """模块3 量能：5/20日均成交额 vs 当前。series: [amount,...]（元）。"""
    if len(market_amount_series) < 25:
        return 0, {}
    cur = market_amount_series[-1]
    m5 = sum(market_amount_series[-5:]) / 5
    m20 = sum(market_amount_series[-20:]) / 20
    ratio5 = cur / m5 if m5 else 1
    ratio20 = cur / m20 if m20 else 1
    pts = 0
    pts += 30 if ratio20 > 1.2 else (15 if ratio20 > 1 else -15 if ratio20 < 0.7 else -30)
    pts += 20 if ratio5 > 1.05 else (10 if ratio5 > 1 else -20)
    # 20日均量趋势
    m20_prev = sum(market_amount_series[-40:-20]) / 20
    if m20_prev:
        trend = (m20 / m20_prev - 1) * 100
        pts += 20 if trend > 5 else (10 if trend > 0 else -20)
    pts = max(-100, min(100, pts))
    return round(pts, 1), {
        "cur_yi": round(cur / 1e8, 0), "ma5_yi": round(m5 / 1e8, 0),
        "ma20_yi": round(m20 / 1e8, 0), "ratio20": round(ratio20, 2)}


def score_sentiment(up_n, down_n, limit_up, limit_down, max_board):
    """模块6 情绪：涨跌家数、涨跌停、连板高度。"""
    total = up_n + down_n
    if not total:
        return 0, {}
    pts = 0
    up_ratio = up_n / total
    pts += 60 if up_ratio > 0.65 else (20 if up_ratio > 0.5 else (-20 if up_ratio < 0.35 else -60))
    pts += 20 if limit_up > limit_down * 2 else (10 if limit_up > limit_down else -20)
    pts += 20 if max_board >= 5 else (10 if max_board >= 3 else 0)
    pts = max(-100, min(100, pts))
    return round(pts, 1), {
        "up": up_n, "down": down_n, "up_ratio": round(up_ratio * 100, 1),
        "limit_up": limit_up, "limit_down": limit_down, "max_board": max_board}


def load_macro():
    """宏观/估值模块：从 macro.json 读（手动维护）。"""
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "macro.json")
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def classify(total):
    if total >= 35:
        return "牛市特征较强"
    if total >= 15:
        return "偏多 / 牛市初期待确认"
    if total >= -14:
        return "震荡市 / 方向不明"
    if total >= -34:
        return "偏弱调整 / 熊市风险上升"
    return "熊市特征较强"


def compute_bb_history(official_rows):
    """历史趋势分数回测（用官方 0AMV 序列 vs 20/60/120/250 日均线）。"""
    amv = [r["amv"] for r in official_rows]
    dates = [r["date"] for r in official_rows]
    out = []
    for i in range(250, len(amv)):
        cur = amv[i]
        if cur <= 0:
            continue
        m20 = sum(amv[i - 20:i]) / 20
        m60 = sum(amv[i - 60:i]) / 60
        m120 = sum(amv[i - 120:i]) / 120
        m250 = sum(amv[i - 250:i]) / 250
        pts = 0
        pts += 40 if cur > m20 else -40
        pts += 25 if cur > m60 else -25
        pts += 20 if cur > m120 else -20
        pts += 15 if cur > m250 else -15
        m250_prev = sum(amv[i - 270:i - 20]) / 250 if i >= 270 else m250
        pts += 15 if m250 > m250_prev else -15
        s60 = (amv[i] / amv[i - 60] - 1) * 100 if amv[i - 60] > 0 else 0
        pts += 10 if s60 > 0 else -10
        pts = max(-100, min(100, pts))
        out.append({"date": dates[i], "score": pts})
    return out[-1300:]


def compute_bull_bear(stocks_rows, market_amount_series, sentiment_args):
    """主计算。"""
    indices_rows = {}
    for code, name in INDICES_BB:
        rows = fetch_index_daily(code)
        if rows:
            indices_rows[code] = rows
    trend, trend_details = score_trend(indices_rows)
    breadth, breadth_details = score_breadth(stocks_rows)
    volume, volume_details = score_volume(market_amount_series)
    senti, senti_details = score_sentiment(*sentiment_args)
    macro = load_macro()
    m_score = macro.get("macro_score")
    v_score = macro.get("valuation_score")
    total = (trend * 0.25 + breadth * 0.20 + volume * 0.15 +
             (m_score or 0) * 0.15 + (v_score or 0) * 0.10 + senti * 0.15)
    return {
        "scores": {
            "trend": trend, "breadth": breadth, "volume": volume,
            "macro": m_score, "valuation": v_score, "sentiment": senti,
        },
        "total": round(total, 1),
        "state": classify(total),
        "details": {
            "trend": trend_details,
            "breadth": breadth_details,
            "volume": volume_details,
            "sentiment": senti_details,
            "macro_note": macro.get("note", "暂缺"),
            "macro_asof": macro.get("asof", ""),
        },
    }
