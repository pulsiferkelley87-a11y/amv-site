# -*- coding: utf-8 -*-
"""检查主页数据是否停留在昨天（收盘后）。返回 0=新鲜, 1=过期（需触发 daily）。"""
import datetime
import json
import sys

try:
    with open("data/data.json", encoding="utf-8") as f:
        d = json.load(f)
    today = (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).strftime("%Y-%m-%d")
    last = d["amv_perstock"]["date"][-1]
    print(f"data latest {last}, beijing today {today}")
    sys.exit(0 if last >= today else 1)
except Exception as e:
    print("check err:", str(e)[:80])
    sys.exit(0)
