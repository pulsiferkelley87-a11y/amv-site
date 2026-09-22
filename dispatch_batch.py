# -*- coding: utf-8 -*-
"""连续触发 N 轮云端更新任务（每轮拉 300 只未缓存股票，串行排队）。"""
import json
import os
import time
import urllib.request
import urllib.error

BASE = os.path.dirname(os.path.abspath(__file__))
TOKEN = open(os.path.join(BASE, ".gh_token"), encoding="utf-8").read().strip()
USER = "pulsiferkelley87-a11y"
REPO = "amv-site"


def dispatch():
    req = urllib.request.Request(
        f"https://api.github.com/repos/{USER}/{REPO}/actions/workflows/daily.yml/dispatches",
        method="POST",
        data=json.dumps({"ref": "main"}).encode(),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "amv-batch",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return -1


n = int(os.environ.get("DISPATCH_N", "20"))
print(f"开始连续触发 {n} 轮更新（每轮约拉 300 只新股）...", flush=True)
for i in range(n):
    st = dispatch()
    print(f"  round {i+1}/{n}: HTTP {st}", flush=True)
    time.sleep(15)
print("触发完成。GitHub 将排队串行执行，全部完成后缓存覆盖全市场。", flush=True)
