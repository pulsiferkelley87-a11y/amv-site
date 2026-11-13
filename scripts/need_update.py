# -*- coding: utf-8 -*-
"""need_update.py —— 定时任务闸门：云端数据已经是今天（且今天不是周末）就跳过。

用法：
  python scripts/need_update.py <COS键> [--field updated_at] [--skip-weekend]
  python scripts/need_update.py --today-key "minute/600000/{date}/p7.json" [--skip-weekend]

{date} 会替换成北京时间的 YYYYMMDD。

输出到 $GITHUB_OUTPUT：run=true / run=false
"""
import datetime
import json
import os
import sys
import urllib.request

COS = "https://amv-live-1500351250.cos.ap-guangzhou.myqcloud.com"


def bj_now():
    return datetime.datetime.utcnow() + datetime.timedelta(hours=8)


def head_lm(key):
    req = urllib.request.Request("%s/%s" % (COS, key), method="HEAD")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.headers.get("Last-Modified")


def lm_bj_date(lm):
    dt = datetime.datetime.strptime(lm, "%a, %d %b %Y %H:%M:%S GMT")
    return (dt + datetime.timedelta(hours=8)).strftime("%Y-%m-%d")


def field_date(key, field):
    try:
        with urllib.request.urlopen("%s/%s" % (COS, key), timeout=60) as r:
            j = json.loads(r.read().decode("utf-8"))
        return str(j.get(field) or "")[:10].replace("/", "-")
    except Exception:
        return ""


def main():
    args = sys.argv[1:]
    now = bj_now()
    today = now.strftime("%Y-%m-%d")
    run = True
    reason = ""

    if "--skip-weekend" in args and now.weekday() >= 5:
        print("闸门：今天是周末（%s），跳过" % now.strftime("%a"))
        run = False
        reason = "weekend"

    key, field, today_key = "", "", ""
    if "--field" in args:
        field = args[args.index("--field") + 1]
    if "--today-key" in args:
        today_key = args[args.index("--today-key") + 1].replace("{date}", now.strftime("%Y%m%d"))
    if args and not args[0].startswith("--"):
        key = args[0]
    if today_key:
        key = today_key

    if run and key:
        try:
            lm = head_lm(key)
            d = lm_bj_date(lm)
            print("闸门：%s Last-Modified=%s → 北京 %s（今天 %s）" % (key, lm, d, today))
            if d == today:
                run = False
                reason = "already-updated-today"
        except Exception as e:
            print("闸门：HEAD %s 失败（%s），按需要跑处理" % (key, str(e)[:80]))
    if run and field and key:
        fd = field_date(key, field)
        print("闸门：%s.%s = %s" % (key, field, fd or "空"))
        if fd == today:
            run = False
            reason = "field-is-today"

    print("闸门结论：run=%s %s" % ("true" if run else "false", ("(%s)" % reason) if reason else ""))
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a", encoding="utf-8") as f:
            f.write("run=%s\n" % ("true" if run else "false"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
