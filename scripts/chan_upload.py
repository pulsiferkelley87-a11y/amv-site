# -*- coding: utf-8 -*-
"""chan_upload.py — 上传缠论扫描产物到 COS（多线程 + 单文件重试 + 部分成功不判死）

上传内容：
  <OUT>/chan_scan.json      → chan_scan.json        （关键产物，失败即整轮失败）
  <OUT>/chan/<code>.json    → chan/<code>.json      （信号池个股日线快照，允许部分失败）

环境变量：
  COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION
  CHAN_OUT      产物目录，默认 _chan/out
  UPLOAD_WORKERS 并发，默认 6
  UPLOAD_FAIL_RATIO 允许失败比例，默认 0.4（超过才判整轮失败）
"""
import glob
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from qcloud_cos import CosConfig, CosS3Client

SECRET_ID = os.environ.get("COS_SECRET_ID", "")
SECRET_KEY = os.environ.get("COS_SECRET_KEY", "")
BUCKET = os.environ.get("COS_BUCKET", "")
REGION = os.environ.get("COS_REGION", "ap-guangzhou")
WORKERS = int(os.environ.get("UPLOAD_WORKERS", "6"))
FAIL_RATIO = float(os.environ.get("UPLOAD_FAIL_RATIO", "0.4"))
OUT = os.environ.get("CHAN_OUT", "_chan/out")

if not SECRET_ID or not SECRET_KEY or not BUCKET:
    print("missing COS env vars, skip upload")
    sys.exit(0)

CFG = CosConfig(Region=REGION, SecretId=SECRET_ID, SecretKey=SECRET_KEY, Timeout=180)


def put_once(local, key):
    client = CosS3Client(CFG)  # 每线程一个 client，避免共享 session 竞争
    client.upload_file(Bucket=BUCKET, LocalFilePath=local, Key=key,
                       ContentType="application/json", EnableMD5=False)
    return key


def put(local, key, attempts=3):
    """单文件最多重试 3 次（0.5s / 1.5s / 3s + 抖动），返回 (key, ok, err)"""
    last = None
    for i in range(attempts):
        try:
            put_once(local, key)
            return key, True, None
        except Exception as e:  # noqa: BLE001
            last = e
            if i < attempts - 1:
                time.sleep(0.5 * (3 ** i) + random.random() * 0.4)
    return key, False, str(last)[:160]


def main():
    scan = os.path.join(OUT, "chan_scan.json")
    if not os.path.exists(scan):
        print("!! 缺少 %s，无法上传" % scan)
        return 1

    # ① 关键产物：先传，失败就整轮失败（页面靠它显示清单）
    key, ok, err = put(scan, "chan_scan.json", attempts=4)
    if not ok:
        print("!! chan_scan.json 上传失败：", err)
        return 1
    print("chan_scan.json ✓ %d B" % os.path.getsize(scan))

    # ② 个股快照：允许部分失败
    files = sorted(glob.glob(os.path.join(OUT, "chan", "*.json")))
    print("个股快照 %d 个，并发 %d" % (len(files), WORKERS))
    done = failed = 0
    errs = []
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for key, ok, err in ex.map(lambda p: put(p, "chan/" + os.path.basename(p)), files):
            done += 1
            if not ok:
                failed += 1
                if len(errs) < 8:
                    errs.append(key)
            if done % 200 == 0:
                print("进度 %d/%d（失败 %d）" % (done, len(files), failed))

    total = len(files)
    print("个股快照完成：成功 %d / 失败 %d（共 %d）" % (total - failed, failed, total))
    if errs:
        print("失败样例：", ", ".join(errs))

    if total and failed / total > FAIL_RATIO:
        print("!! 失败比例 %.0f%% 超过阈值 %.0f%%，判整轮失败" % (failed * 100.0 / total, FAIL_RATIO * 100))
        return 1
    if failed:
        print("部分失败，但已传的够用（页面缺图时会回退东财），本轮不判失败")
    return 0


if __name__ == "__main__":
    sys.exit(main())
