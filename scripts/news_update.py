# -*- coding: utf-8 -*-
"""轻量快讯更新：抓新浪 7x24 财经快讯 → news.json（独立文件，每小时由 news.yml 触发）。"""
import json
import time

import requests

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
    "Referer": "https://finance.sina.com.cn/",
})


def fetch_sina_news():
    r = session.get(
        "https://zhibo.sina.com.cn/api/zhibo/feed",
        params={"page": 1, "page_size": 30, "zhibo_id": 152,
                "tag_id": 0, "dire": "f", "dpc": 1},
        timeout=20)
    j = r.json()
    feed = (j.get("result") or {}).get("data") or {}
    lst = (feed.get("feed") or {}).get("list") or []
    out = []
    for it in lst:
        text = (it.get("rich_text") or "").strip()
        if not text:
            continue
        out.append({
            "time": (it.get("create_time") or "")[:16],
            "text": text,
        })
    return out


def fetch_em_news():
    """东财 7x24 快讯（A 股个股公告/期货/政策）。"""
    s = requests.Session()
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
        "Referer": "https://kuaixun.eastmoney.com/",
    })
    try:
        r = s.get("https://np-listapi.eastmoney.com/comm/web/getFastNewsList",
                  params={"client": "web", "biz": "web_724", "fastColumn": "102",
                          "sortEnd": "", "pageSize": 30, "req_trace": "1"},
                  timeout=20)
        j = r.json()
        items = (j.get("data") or {}).get("fastNewsList") or []
        out = []
        for it in items:
            text = (it.get("title") or it.get("summary") or "").strip()
            if not text:
                continue
            out.append({
                "time": (it.get("showTime") or "")[:16],
                "text": text,
            })
        return out
    except Exception:
        return []


GOOD_WORDS = ["利好", "获批", "中标", "预增", "超预期", "回购", "增持", "涨价", "创新高",
             "签约", "净流入", "降息", "降温", "提振", "上调", "回暖", "强劲", "突破", "加速",
             "翻红", "大涨", "新高"]
BAD_WORDS = ["利空", "处罚", "立案", "亏损", "下滑", "减持", "退市", "违规", "爆雷", "下调",
             "净流出", "加息", "升温", "萎缩", "疲软", "大跌", "暴跌", "违约"]


def main():
    news = fetch_sina_news()
    em = fetch_em_news()
    # 合并去重（按文本），按时间倒序，各取前 20
    seen = set()
    merged = []
    for n in news + em:
        key = n["text"][:30]
        if key in seen:
            continue
        seen.add(key)
        merged.append(n)
    merged.sort(key=lambda x: x["time"], reverse=True)
    merged = merged[:40]
    if not merged:
        print("no news fetched")
        return 1
    bj_today = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 8 * 3600))
    bj_now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + 8 * 3600))
    payload = {
        "updated_at": bj_now,
        "news": merged,
    }
    with open("news.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    # 今日利好速览（只存当天，每天覆盖）
    good = [n for n in merged
            if n["time"].startswith(bj_today)
            and any(k in n["text"] for k in GOOD_WORDS)
            and not any(k in n["text"] for k in BAD_WORDS)]
    with open("good_news.json", "w", encoding="utf-8") as f:
        json.dump({"date": bj_today, "updated_at": bj_now, "items": good},
                  f, ensure_ascii=False)
    print(f"news: sina {len(news)} + em {len(em)} -> {len(merged)} items, 今日利好 {len(good)} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
