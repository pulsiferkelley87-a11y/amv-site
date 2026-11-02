# -*- coding: utf-8 -*-
"""verify_sources.py —— 通达信云端源与本地 vipdoc 的交叉验真。

用法：
    python scripts/verify_sources.py            # 默认样本
    python scripts/verify_sources.py 600000 000001

对每只票按**日期对齐**比较 OHLC / 成交额 / 成交量，输出一致率。
用途：接入管线前确认数据口径，以及排查"云端与本地不一致"的争议。
"""
import sys
import time

import tdx_source as S

DEFAULT = ["600000", "000001", "600519", "300750", "601318", "002594", "688981", "000858"]

TOL_PRICE = 0.011          # 价格容差（百分比价位，允许 1 分钱四舍五入）
TOL_RATIO = 0.001          # 成交额/量容差 0.1%（float32 存储误差）


def cmp_rows(a, b):
    """按日期对齐比较两组行，返回 (共同日期数, 不一致明细)。"""
    da = {r["date"]: r for r in a}
    db = {r["date"]: r for r in b}
    common = sorted(set(da) & set(db))
    bad = []
    for d in common:
        x, y = da[d], db[d]
        if (abs(x["open"] - y["open"]) > TOL_PRICE
                or abs(x["high"] - y["high"]) > TOL_PRICE
                or abs(x["low"] - y["low"]) > TOL_PRICE
                or abs(x["close"] - y["close"]) > TOL_PRICE):
            bad.append((d, "OHLC", x, y))
        elif abs(x["amount"] - y["amount"]) > max(1.0, y["amount"] * TOL_RATIO):
            bad.append((d, "成交额", x, y))
        elif abs(x["volume"] - y["volume"]) > max(1.0, y["volume"] * TOL_RATIO):
            bad.append((d, "成交量", x, y))
    return common, bad


def main(argv):
    codes = argv[1:] or DEFAULT
    print("通达信数据源验真  endpoint=%s\n" % S.ENDPOINT)

    total_common = total_bad = 0
    for code in codes:
        try:
            cloud = S.daily(code, 300)
        except Exception as e:
            print("%-8s 云端失败: %s" % (code, str(e)[:80]))
            continue
        local = S.read_local_day(code, 300)
        if not local:
            print("%-8s 云端 %d 条；本地无 .day（跳过比对）  区间 %s~%s"
                  % (code, len(cloud), cloud[0]["date"], cloud[-1]["date"]))
            continue
        common, bad = cmp_rows(cloud, local)
        total_common += len(common)
        total_bad += len(bad)
        newer = sorted(set(r["date"] for r in cloud) - set(r["date"] for r in local))
        print("%-8s 云端 %3d 条 | 本地 %3d 条 | 共同 %3d 条 | 一致 %3d | 差异 %d | 云端多 %d 天%s"
              % (code, len(cloud), len(local), len(common),
                 len(common) - len(bad), len(bad), len(newer),
                 (" (" + ",".join(newer[-3:]) + ")") if newer else ""))
        for d, why, x, y in bad[:3]:
            print("     %s [%s] 云端=%s 本地=%s" % (d, why, x, y))

    print("\n合计：共同日期 %d 条，不一致 %d 条%s"
          % (total_common, total_bad,
             "，口径完全一致" if total_bad == 0 else ""))

    # 并发批量测速
    print("\n并发批量（%d 只 × 60 根，8 线程）…" % len(codes))
    t0 = time.time()
    res = S.batch_daily(codes, want_num=60, workers=8)
    el = time.time() - t0
    ok = sum(1 for v in res.values() if v["rows"])
    src = {}
    for v in res.values():
        src[v["source"]] = src.get(v["source"], 0) + 1
    print("  成功 %d/%d，用时 %.2fs，平均 %.0f ms/只，来源分布 %s"
          % (ok, len(codes), el, el / max(1, len(codes)) * 1000, src))
    print("  外推 5000 只（8 线程）约 %.1f 分钟" % (el / max(1, len(codes)) * 5000 / 60))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
