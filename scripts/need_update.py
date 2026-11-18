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


def field_ts(key, field):
    """取完整时间戳字段（如 2026-11-17 23:17:07）。"""
    try:
        with urllib.request.urlopen("%s/%s" % (COS, key), timeout=60) as r:
            j = json.loads(r.read().decode("utf-8"))
        return str(j.get(field) or "")
    except Exception:
        return ""


def ts_age_min(ts):
    """把北京时间字符串时间戳换算成距今多少分钟。"""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            dt = datetime.datetime.strptime(str(ts).strip(), fmt)
            return (bj_now() - dt).total_seconds() / 60.0
        except Exception:
            continue
    return None


def ts_hm(ts):
    """从时间戳里取 (时, 分)。"""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            dt = datetime.datetime.strptime(str(ts).strip(), fmt)
            return (dt.hour, dt.minute)
        except Exception:
            continue
    return None


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

    min_time = None
    if "--min-time" in args:
        try:
            hh, mm = args[args.index("--min-time") + 1].split(":")
            min_time = (int(hh), int(mm))
        except Exception:
            min_time = None

    max_age = None
    if "--max-age-min" in args:
        try:
            max_age = float(args[args.index("--max-age-min") + 1])
        except Exception:
            max_age = None

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
        fd = field_date(key, field) if field else ""
        raw_ts = field_ts(key, field) if field else ""
        if run and max_age is not None:
            age = ts_age_min(raw_ts) if raw_ts else None
            if age is None:
                try:
                    lm = head_lm(key)
                    dt = datetime.datetime.strptime(lm, "%a, %d %b %Y %H:%M:%S GMT") + datetime.timedelta(hours=8)
                    age = (now - dt).total_seconds() / 60.0
                except Exception:
                    age = None
            if age is not None and age < max_age:
                print("闸门：数据 %.1f 分钟前刚更新（阈值 %s 分钟），跳过" % (age, max_age))
                run = False
                reason = "too-fresh"
        if field and fd:
            # 有业务日期字段（如 updated_at / trade_date）时以它为准：
            # 文件可能今天被重传，但里面装的是昨天算出来的数据。
            print("闸门：%s.%s = %s（今天 %s）" % (key, field, fd, today))
            if fd == today and max_age is None:
                keep = False
                if min_time is not None:
                    tt = ts_hm(raw_ts)
                    if tt is not None and tt < min_time:
                        keep = True
                        print("闸门：今天的扫描发生在 %02d:%02d（早于收盘后 %02d:%02d），仍需重扫" % (tt[0], tt[1], min_time[0], min_time[1]))
                if keep:
                    reason = "before-cutoff"
                else:
                    run = False
                    reason = "field-is-today"
        else:
            try:
                lm = head_lm(key)
                d = lm_bj_date(lm)
                print("闸门：%s Last-Modified=%s → 北京 %s（今天 %s）" % (key, lm, d, today))
                if d == today:
                    run = False
                    reason = "already-updated-today"
            except Exception as e:
                print("闸门：HEAD %s 失败（%s），按需要跑处理" % (key, str(e)[:80]))

    print("闸门结论：run=%s %s" % ("true" if run else "false", ("(%s)" % reason) if reason else ""))
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a", encoding="utf-8") as f:
            f.write("run=%s\n" % ("true" if run else "false"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
