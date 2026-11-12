# -*- coding: utf-8 -*-
"""chan_upload.py — 上传缠论扫描产物到 COS（多线程）。

上传内容：
  _chan/out/chan_scan.json      → chan_scan.json
  _chan/out/chan/<code>.json    → chan/<code>.json   （信号池个股日线快照）
"""
import glob
import os
import sys
from concurrent.futures import ThreadPoolExecutor

from qcloud_cos import CosConfig, CosS3Client

SECRET_ID = os.environ.get("COS_SECRET_ID", "")
SECRET_KEY = os.environ.get("COS_SECRET_KEY", "")
BUCKET = os.environ.get("COS_BUCKET", "")
REGION = os.environ.get("COS_REGION", "ap-guangzhou")
WORKERS = int(os.environ.get("UPLOAD_WORKERS", "8"))

if not SECRET_ID or not SECRET_KEY or not BUCKET:
    print("missing COS env vars, skip upload")
    sys.exit(0)

CFG = CosConfig(Region=REGION, SecretId=SECRET_ID, SecretKey=SECRET_KEY, Timeout=300)


def put(local, key):
    client = CosS3Client(CFG)  # 每线程一个 client，避免共享 session 竞争
    client.upload_file(Bucket=BUCKET, LocalFilePath=local, Key=key,
                       ContentType="application/json", EnableMD5=False)
    return key


tasks = []
scan = "_chan/out/chan_scan.json"
if os.path.exists(scan):
    tasks.append((scan, "chan_scan.json"))
for p in sorted(glob.glob("_chan/out/chan/*.json")):
    tasks.append((p, "chan/" + os.path.basename(p)))

print("to upload", len(tasks))
done = 0
with ThreadPoolExecutor(max_workers=WORKERS) as ex:
    for key in ex.map(lambda t: put(*t), tasks):
        done += 1
        if done % 200 == 0:
            print("uploaded", done)
print("upload done", done)
