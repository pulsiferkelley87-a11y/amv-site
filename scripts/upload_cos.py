# -*- coding: utf-8 -*-
"""upload_cos.py - 把 _site 目录的静态文件上传到腾讯云 COS（公有读）。

- 由 GitHub Actions 调用（health.yml 每 15 分钟），环境变量提供密钥
- 排除 live_data.json（实盘云函数每 1 分钟更新，不能覆盖）
- 上传后访问地址：https://{bucket}.cos.{region}.myqcloud.com/index.html
"""
import glob
import os
import sys

from qcloud_cos import CosConfig, CosS3Client

SECRET_ID = os.environ.get("COS_SECRET_ID", "")
SECRET_KEY = os.environ.get("COS_SECRET_KEY", "")
BUCKET = os.environ.get("COS_BUCKET", "")
REGION = os.environ.get("COS_REGION", "ap-guangzhou")

EXCLUDE = {"live_data.json"}  # 实盘云函数每分钟更新，静态同步不得覆盖

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".gz": "application/gzip",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}


def content_type_of(name):
    ext = os.path.splitext(name)[1].lower()
    return CONTENT_TYPES.get(ext, "application/octet-stream")

if not SECRET_ID or not SECRET_KEY or not BUCKET:
    print("missing COS env vars, skip upload")
    sys.exit(0)

config = CosConfig(Region=REGION, SecretId=SECRET_ID, SecretKey=SECRET_KEY, Timeout=300)
client = CosS3Client(config)

def safe_upload(path, name):
    """上传单个文件。大文件用分片（upload_file），.gz 临时改名避开 SDK 特殊处理。"""
    import shutil
    tmp = None
    local_path = path
    try:
        if name.endswith(".gz"):
            tmp = path + ".uploadtmp"
            shutil.copy(path, tmp)
            local_path = tmp
        client.upload_file(
            Bucket=BUCKET,
            LocalFilePath=local_path,
            Key=name,
            ContentType=content_type_of(name),
            EnableMD5=False,
        )
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)


files = sorted(glob.glob("_site/*"))
uploaded, skipped = 0, 0
for path in files:
    name = os.path.basename(path)
    if name in EXCLUDE:
        skipped += 1
        continue
    try:
        uploaded_file = False
        last_err = ""
        for attempt in range(3):
            try:
                safe_upload(path, name)
                uploaded_file = True
                break
            except Exception as e:
                last_err = str(e)[:150]
                import time as _t
                _t.sleep(3)
        if uploaded_file:
            uploaded += 1
        else:
            print("upload failed %s: %s" % (name, last_err))
    except Exception as e:
        print("upload failed %s: %s" % (name, str(e)[:150]))

print("COS upload done: %d uploaded, %d skipped (live_data.json)" % (uploaded, skipped))
