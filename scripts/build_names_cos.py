# -*- coding: utf-8 -*-
"""build_names_cos.py —— 从 data/data.json 生成全市场 code→name，上传 COS chan/names.json。

页面搜索框（代码/名称模糊匹配）读的就是这个文件；放进每日任务里，
新股上市后第二天就能搜到，不用再手工传。
"""
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.request

BUCKET = os.environ.get("COS_BUCKET", "amv-live-1500351250")
REGION = os.environ.get("COS_REGION", "ap-guangzhou")
SID = os.environ.get("COS_SECRET_ID", "")
SKEY = os.environ.get("COS_SECRET_KEY", "")


def cos_put(key, body):
    if not (SID and SKEY):
        print("缺 COS 密钥，跳过上传")
        return 0
    host = "%s.cos.%s.myqcloud.com" % (BUCKET, REGION)
    now = int(time.time())
    sign_time = "%d;%d" % (now - 60, now + 900)
    sign_key = hmac.new(SKEY.encode(), sign_time.encode(), hashlib.sha1).hexdigest()
    http_string = "put\n/%s\n\nhost=%s\n" % (key, host)
    string_to_sign = "sha1\n%s\n%s\n" % (
        sign_time, hashlib.sha1(http_string.encode()).hexdigest())
    sig = hmac.new(sign_key.encode(), string_to_sign.encode(), hashlib.sha1).hexdigest()
    auth = ("q-sign-algorithm=sha1&q-ak=%s&q-sign-time=%s&q-key-time=%s"
            "&q-header-list=host&q-url-param-list=&q-signature=%s"
            % (SID, sign_time, sign_time, sig))
    req = urllib.request.Request("https://%s/%s" % (host, key), data=body,
                                 method="PUT", headers={"Authorization": auth, "Host": host})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status


def main():
    path = os.path.join("data", "data.json")
    if not os.path.exists(path):
        print("没有 %s，跳过" % path)
        return 0
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    stocks = d.get("all_stocks") or []
    names = {}
    for s in stocks:
        code = str(s.get("code") or "").strip()
        name = str(s.get("name") or "").strip()
        if len(code) == 6 and name:
            names[code] = name
    if not names:
        print("all_stocks 为空，跳过")
        return 1
    body = json.dumps(names, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    st = cos_put("chan/names.json", body)
    print("names.json：%d 只，%d 字节，COS 状态 %s" % (len(names), len(body), st))
    return 0


if __name__ == "__main__":
    sys.exit(main())
