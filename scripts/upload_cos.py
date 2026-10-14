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

if not SECRET_ID or not SECRET_KEY or not BUCKET:
    print("missing COS env vars, skip upload")
    sys.exit(0)

config = CosConfig(Region=REGION, SecretId=SECRET_ID, SecretKey=SECRET_KEY)
client = CosS3Client(config)

files = sorted(glob.glob("_site/*"))
uploaded, skipped = 0, 0
for path in files:
    name = os.path.basename(path)
    if name in EXCLUDE:
        skipped += 1
        continue
    try:
        client.upload_file(
            Bucket=BUCKET,
            LocalFilePath=path,
            Key=name,
            EnableMD5=False,
        )
        uploaded += 1
    except Exception as e:
        print("upload failed %s: %s" % (name, str(e)[:120]))

print("COS upload done: %d uploaded, %d skipped (live_data.json)" % (uploaded, skipped))
