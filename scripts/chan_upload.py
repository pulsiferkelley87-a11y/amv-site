# -*- coding: utf-8 -*-
"""chan_upload.py — 上传缠论扫描产物到 COS。

上传内容：
  _chan/out/chan_scan.json      → chan_scan.json
  _chan/out/chan/<code>.json    → chan/<code>.json   （信号池个股日线快照）
"""
import glob
import os
import sys

from qcloud_cos import CosConfig, CosS3Client

SECRET_ID = os.environ.get("COS_SECRET_ID", "")
SECRET_KEY = os.environ.get("COS_SECRET_KEY", "")
BUCKET = os.environ.get("COS_BUCKET", "")
REGION = os.environ.get("COS_REGION", "ap-guangzhou")

if not SECRET_ID or not SECRET_KEY or not BUCKET:
    print("missing COS env vars, skip upload")
    sys.exit(0)

client = CosS3Client(CosConfig(Region=REGION, SecretId=SECRET_ID, SecretKey=SECRET_KEY, Timeout=300))

scan = "_chan/out/chan_scan.json"
if os.path.exists(scan):
    client.upload_file(Bucket=BUCKET, LocalFilePath=scan, Key="chan_scan.json",
                       ContentType="application/json", EnableMD5=False)
    print("upload chan_scan.json", os.path.getsize(scan), "B")

pool = sorted(glob.glob("_chan/out/chan/*.json"))
for p in pool:
    key = "chan/" + os.path.basename(p)
    client.upload_file(Bucket=BUCKET, LocalFilePath=p, Key=key,
                       ContentType="application/json", EnableMD5=False)
print("upload pool", len(pool), "files")
