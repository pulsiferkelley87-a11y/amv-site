# -*- coding: utf-8 -*-
"""warm_flow.py —— 批量抓「主力资金日线」写入 COS，供网站 K 线的「主力筹码带」读取。

为什么要缓存到 COS：
  东财接口虽然能跨域直连，但浏览器直连会带着我们自己站点的 Referer、
  每个用户用自己的 IP，被限流/封禁时「主力带」就会静默消失。
  改成云端每天抓一次存进 COS，页面只读自己的 COS —— 稳定、快、不依赖第三方。

产物：flow/{code6}.json
  {"code":"300408","updated_at":"2026-11-08 22:10:00",
   "days":{"2026-11-06":[主力净额, 超大单+0.2×大单], ...}}
  第二个数就是通达信公式里的「主力买入」项（近似 L2 口径）。

用法：
  python scripts/warm_flow.py                 # 全市场（live_data.json 的 stocks）
  python scripts/warm_flow.py --limit 50      # 只跑前 50 只（调试）
  python scripts/warm_flow.py --codes 300408,600519
  python scripts/warm_flow.py --list          # 只看名单
"""
import argparse
import hashlib
import hmac
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HOST_REPO = "https://amv-live-1500351250.cos.ap-guangzhou.myqcloud.com"
BUCKET = os.environ.get("COS_BUCKET", "amv-live-1500351250")
REGION = os.environ.get("COS_REGION", "ap-guangzhou")
SID = os.environ.get("COS_SECRET_ID", "")
SKEY = os.environ.get("COS_SECRET_KEY", "")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")


# ── COS ────────────────────────────────────────────────────
def _auth(method, path):
    now = int(time.time())
    st = "%d;%d" % (now - 60, now + 900)
    key = hmac.new(SKEY.encode(), st.encode(), hashlib.sha1).hexdigest()
    host = "%s.cos.%s.myqcloud.com" % (BUCKET, REGION)
    http_string = "%s\n/%s\n\nhost=%s\n" % (method.lower(), path, host)
    sign = hmac.new(key.encode(),
                    ("sha1\n%s\n%s\n" % (st, hashlib.sha1(http_string.encode()).hexdigest())).encode(),
                    hashlib.sha1).hexdigest()
    return ("q-sign-algorithm=sha1&q-ak=%s&q-sign-time=%s&q-key-time=%s"
            "&q-header-list=host&q-url-param-list=&q-signature=%s" % (SID, st, st, sign))


def cos_put(path, data, timeout=30):
    if not (SID and SKEY):
        return 0
    host = "%s.cos.%s.myqcloud.com" % (BUCKET, REGION)
    req = urllib.request.Request("https://%s/%s" % (host, path), data=data, method="PUT",
                                 headers={"Authorization": _auth("PUT", path), "Host": host})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except Exception:
        return 0


def get_json(name, timeout=25):
    try:
        with urllib.request.urlopen(HOST_REPO + "/" + name + "?t=" + str(int(time.time())),
                                    timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return None


# ── 东财 ───────────────────────────────────────────────────
def secid(c6):
    """东财市场前缀：1=沪 0=深/北。

    坑：不能只按首位判断。9 开头有两种完全不同的人：
      900xxx = 沪市 B 股 → 1
      920xxx = 北交所     → 0   （按首位判会变成 1.920007，接口返回 0 天）
    同理 4/8 开头是北交所/新三板，也在 0。
    """
    if c6.startswith(("92", "43", "83", "87", "4", "8")):
        return "0." + c6
    return ("1." if c6[0] in "659" else "0.") + c6


def fetch_flow(c6, attempts=3):
    u = ("https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get"
         "?lmt=0&klt=101&secid=" + secid(c6)
         + "&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61")
    for k in range(attempts):
        try:
            req = urllib.request.Request(u, headers={
                "User-Agent": UA, "Referer": "https://quote.eastmoney.com/", "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=15) as r:
                j = json.loads(r.read().decode("utf-8", "replace"))
            kl = ((j.get("data") or {}).get("klines")) or []
            if not kl:
                raise ValueError("空数据")
            days = {}
            for s in kl:
                a = s.split(",")
                if len(a) < 6:
                    continue
                main = float(a[1] or 0)
                big = float(a[4] or 0)
                xbig = float(a[5] or 0)
                days[a[0]] = [round(main, 2), round(xbig + 0.2 * big, 2)]
            return days
        except Exception:
            if k == attempts - 1:
                return None
            time.sleep(1.2 * (k + 1))
    return None


def all_market():
    ld = get_json("live_data.json") or {}
    out = []
    for s in (ld.get("stocks") or []):
        c = str(s.get("code") or "")[-6:]
        if len(c) == 6 and c.isdigit() and c not in out:
            out.append(c)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--codes", default="", help="逗号分隔，指定股票")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=4, help="并发（默认 4，别把东财打急）")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()

    codes = [c.strip()[-6:] for c in a.codes.split(",") if c.strip()] if a.codes else all_market()
    if a.limit:
        codes = codes[:a.limit]
    print("主力资金预热：%d 只，并发 %d，COS=%s" % (len(codes), a.workers, BUCKET))
    if a.list:
        print(" ".join(codes[:50]), "...")
        return 0
    if not (SID and SKEY):
        print("缺 COS_SECRET_ID / COS_SECRET_KEY")
        return 2

    lock = threading.Lock()
    stat = {"ok": 0, "fail": 0, "nofile": 0}
    t0 = time.time()
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")

    def work(i_c):
        i, c = i_c
        days = fetch_flow(c)
        if not days:
            with lock:
                stat["fail"] += 1
            return
        body = json.dumps({"code": c, "updated_at": stamp, "days": days},
                          ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        st = cos_put("flow/%s.json" % c, body)
        with lock:
            if st == 200:
                stat["ok"] += 1
            else:
                stat["nofile"] += 1
        if (stat["ok"] + stat["fail"] + stat["nofile"]) % 200 == 0:
            print("  ... 已处理 %d，成功 %d，失败 %d"
                  % (stat["ok"] + stat["fail"] + stat["nofile"], stat["ok"], stat["fail"]))

    with ThreadPoolExecutor(max_workers=max(1, a.workers)) as ex:
        list(ex.map(work, list(enumerate(codes, 1))))

    print("完成：成功 %d ｜ 取数失败 %d ｜ 上传失败 %d ｜ 耗时 %.0fs"
          % (stat["ok"], stat["fail"], stat["nofile"], time.time() - t0))
    return 0 if stat["fail"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
