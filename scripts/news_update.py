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
        params={"page": 1, "page_size": 100, "zhibo_id": 152,
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
    """东财 7x24 快讯（主域被风控时轮换备用域名）。"""
    s = requests.Session()
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
        "Referer": "https://kuaixun.eastmoney.com/",
    })
    hosts = ["np-listapi.eastmoney.com", "np-weblist.eastmoney.com",
             "np-anotice-stock.eastmoney.com"]
    for host in hosts:
        try:
            r = s.get(f"https://{host}/comm/web/getFastNewsList",
                      params={"client": "web", "biz": "web_724", "fastColumn": "102",
                              "sortEnd": "", "pageSize": 100, "req_trace": "1"},
                      timeout=20)
            j = r.json()
            items = (j.get("data") or {}).get("fastNewsList") or []
            if not items:
                continue
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
            continue
    return []


GOOD_WORDS = ["利好", "获批", "中标", "预增", "超预期", "回购", "增持", "涨价", "创新高",
             "签约", "净流入", "降息", "降温", "提振", "上调", "回暖", "强劲", "突破", "加速",
             "翻红", "大涨", "新高"]
BAD_WORDS = ["利空", "处罚", "立案", "亏损", "下滑", "减持", "退市", "违规", "爆雷", "下调",
             "净流出", "加息", "升温", "萎缩", "疲软", "大跌", "暴跌", "违约"]


def fetch_jin10():
    """金十数据快讯（带 app header 可用），拉 2 页凑更多。时间从 id 前 14 位解析。"""
    import re as _re
    s = requests.Session()
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
        "x-app-id": "bVBF4FyRTn5NJF5n",
        "x-version": "1.0.0",
        "Referer": "https://www.jin10.com/",
    })
    out = []
    max_time = ""
    for _page in range(3):
        try:
            r = s.get("https://flash-api.jin10.com/get_flash_list",
                      params={"channel": "-8200", "vip": "1", "max_time": max_time},
                      timeout=20)
            j = r.json()
            items = (j.get("data") or [])
            if not items:
                break
            for it in items:
                d = it.get("data") or {}
                content = _re.sub(r"<[^>]+>", "", (d.get("content") or "").strip())
                if not content:
                    continue
                # 去掉"金十数据X月X日讯，"前缀，便于跨源去重
                content = _re.sub(r"^金十数据\d+月\d+日讯[，,]\s*", "", content)
                rid = it.get("id") or ""
                t = (f"{rid[0:4]}-{rid[4:6]}-{rid[6:8]} {rid[8:10]}:{rid[10:12]}"
                     if len(rid) >= 12 else "")
                out.append({"time": t, "text": content})
            max_time = items[-1].get("id") or ""
        except Exception:
            break
    return out


def main():
    news = fetch_sina_news()
    em = fetch_em_news()
    j10 = fetch_jin10()
    # 合并去重（按文本），按时间倒序，取前 45
    seen = set()
    merged = []
    for n in news + em + j10:
        key = n["text"][:30]
        if key in seen:
            continue
        seen.add(key)
        merged.append(n)
    merged.sort(key=lambda x: x["time"], reverse=True)
    all_news = merged[:250]           # 全天候筛利好用（保留更多）
    merged = merged[:45]              # 页面显示 45 条
    if not merged:
        print("no news fetched")
        return 1
    # 新鲜度保护：抓到的数据比现有旧则跳过覆盖（云端被风控时会抓到旧数据，防回退）
    try:
        with open("news.json", encoding="utf-8") as f:
            old = json.load(f)
        old_t = (old.get("news") or [{}])[0].get("time", "")
        new_t = merged[0].get("time", "")
        if old_t and new_t and new_t < old_t:
            print(f"news: 抓到的数据({new_t})旧于现有({old_t})，跳过覆盖")
            return 0
    except (OSError, ValueError):
        pass
    bj_today = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 8 * 3600))
    bj_now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + 8 * 3600))
    payload = {
        "updated_at": bj_now,
        "news": merged,
    }
    with open("news.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    # 今日利好速览：从全天候列表里筛当天利好（只存当天，每天覆盖）
    good = [n for n in all_news
            if n["time"].startswith(bj_today)
            and any(k in n["text"] for k in GOOD_WORDS)
            and not any(k in n["text"] for k in BAD_WORDS)]
    with open("good_news.json", "w", encoding="utf-8") as f:
        json.dump({"date": bj_today, "updated_at": bj_now, "items": good},
                  f, ensure_ascii=False)
    print(f"news: sina {len(news)} (最新 {news[0]['time'] if news else '-'}) + em {len(em)} (最新 {em[0]['time'] if em else '-'}) + jin10 {len(j10)} (最新 {j10[0]['time'] if j10 else '-'}) -> {len(merged)} items, 今日利好 {len(good)} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
