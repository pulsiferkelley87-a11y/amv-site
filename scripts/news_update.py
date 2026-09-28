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
    payload = {
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "news": merged,
    }
    with open("news.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"news: sina {len(news)} + em {len(em)} -> {len(merged)} items")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
