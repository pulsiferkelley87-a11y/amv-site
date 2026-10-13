# -*- coding: utf-8 -*-
"""tdxhub.py - 通达信 TQLEX 数据服务客户端（requests 实现）。

数据源: http://tdxhub.icfqs.com:7615/TQLEX（通达信龙虾 tdx-finance 插件同一后端）
协议: POST + JSON；Entry 为 TQLEX 过程名；默认匿名可用（可选 token header）。
验证: 2026-10-12 实测 quotes/kline 均 200，延迟约 180ms。

K线周期编码（PBFXT 实测）:
    0/1/2 = 分时/分钟线  3 = 15分钟线  4 = 日线  5 = 周线
    6 = 月线  10 = 季线  11 = 年线
setcode: '1'=沪 '0'=深 '2'=北
"""
import json

import requests

DEFAULT_ENDPOINT = "http://tdxhub.icfqs.com:7615/TQLEX"
TIMEOUT = 15


def _post(endpoint, body, token=None, timeout=TIMEOUT):
    """POST JSON 到 TQLEX，返回解析后的 JSON；TQLEX 错误抛异常。"""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["token"] = token
    r = requests.post(endpoint, data=json.dumps(body), headers=headers, timeout=timeout)
    text = r.text
    if not r.ok or text.startswith("E|"):
        raise RuntimeError("tdxhub error (status=%s): %s" % (r.status_code, text[:300]))
    try:
        return r.json()
    except ValueError:
        return text


def _head(target="0"):
    return {"Head": {"Target": target, "CharSet": "UTF8"}}


def quotes(code, setcode, opts=None, endpoint=DEFAULT_ENDPOINT, token=None):
    """实时行情快照。返回 {HQInfo, ExtInfo, ...}（无数据时各块为空对象）。"""
    opts = opts or {}
    body = {
        **_head(),
        "Code": str(code),
        "Setcode": str(setcode),
        "HasHQInfo": opts.get("hasHQInfo", "1"),
        "HasExtInfo": opts.get("hasExtInfo", "1"),
        "BspNum": opts.get("bspNum", "5"),
        "HasProInfo": opts.get("hasProInfo", "0"),
        "HasCalcInfo": opts.get("hasCalcInfo", "0"),
        "HasCwInfo": opts.get("hasCwInfo", "0"),
        "HasStatInfo": opts.get("hasStatInfo", "0"),
    }
    return _post(endpoint + "?Entry=TdxShare.PBHQInfo", body, token)


def kline_raw(code, setcode, period=4, want_num=250, startxh=0,
              endpoint=DEFAULT_ENDPOINT, token=None):
    """K线原始返回。period: 4=日线 5=周线 6=月线。
    返回 {"ListHead": {"ItemHead": [...]}, "ListItem": [{"Item": [...]}],
          "AttachInfo": {...}}
    Item 列序: Data,Second,Open,High,Low,Close,Amount,VolInStock,Volume,Settle,up,down
    """
    body = {
        **_head("0"),
        "Code": str(code),
        "Setcode": int(setcode),
        "Period": int(period),
        "Startxh": int(startxh),
        "WantNum": int(want_num),
        "TQFlag": 11,
        "MPData": 0,
        "HasAttachInfo": 1,
        "HasLtgb": 0,
        "ForRefresh": 0,
        "HasIpoPrice": 0,
    }
    return _post(endpoint + "?Entry=TdxShare.PBFXT", body, token)


def kline_daily(code, setcode, want_num=250, endpoint=DEFAULT_ENDPOINT, token=None):
    """日线，返回与 amv-site update_dma.py 兼容的行格式:
    [{"date","close","amount","volume","turnover"(None)}]（按日期升序）。
    """
    j = kline_raw(code, setcode, period=4, want_num=want_num,
                  endpoint=endpoint, token=token)
    out = []
    for row in j.get("ListItem") or []:
        it = row.get("Item") or []
        if len(it) < 9 or not it[0]:
            continue
        try:
            out.append({
                "date": str(it[0]),
                "close": float(it[5]),
                "amount": float(it[6]),
                "volume": float(it[8]) / 100.0,  # TQLEX 单位为股，换算为手，与东财 f5 对齐
                "turnover": None,  # 与腾讯降级通道一致，由 amount/float_mv 近似
            })
        except (TypeError, ValueError):
            continue
    return out


def indicator_select(message, rang="AG", endpoint=DEFAULT_ENDPOINT, token=None):
    """自然语言指标查询（tdx_indicator_select）。"""
    return _post(endpoint + "?Entry=NLPSE:InfoSelectV2",
                 {"message": message, "rang": rang}, token)


def screener(message, rang="AG", endpoint=DEFAULT_ENDPOINT, token=None):
    """自然语言条件选股（tdx_screener 同族）。"""
    return _post(endpoint + "?Entry=JNLPSE:wendaQuery",
                 {"message": message, "rang": rang}, token)


def api_data(entry, body=None, endpoint=DEFAULT_ENDPOINT, token=None):
    """通用 tdx_api_data 调用。entry 为各 tdx-* 技能文档指定的 TQLEX 过程名。"""
    payload = dict(_head())
    payload.update(body or {})
    return _post(endpoint + "?Entry=" + entry, payload, token)


def setcode_of(code):
    """按代码前缀推断 setcode：'6'->'1'(沪) '0'/'3'->'0'(深) '4'/'8'/'9'->'2'(北)。"""
    c = str(code)
    if c.startswith("6"):
        return "1"
    if c.startswith(("0", "3")):
        return "0"
    if c.startswith(("4", "8", "9")):
        return "2"
    return None
