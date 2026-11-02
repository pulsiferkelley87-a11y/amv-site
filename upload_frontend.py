# -*- coding: utf-8 -*-
"""通过 GitHub Contents API 上传前端文件（绕开被重置的 git 传输通道）。

仅上传 app.js / index.html 两个小文件；app-data.js 由云端 workflow 自行生成。
上传后触发 workflow dispatch 部署。
"""
import base64
import json
import os
import time
import urllib.request
import urllib.error

BASE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(BASE, "upload_log.txt")
_tok_file = os.path.join(BASE, ".gh_token")
TOKEN = open(_tok_file, encoding="utf-8").read().strip()
USER = "pulsiferkelley87-a11y"
REPO = "amv-site"


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(line, flush=True)


def api(method, url, body=None):
    for attempt in range(4):
        req = urllib.request.Request(
            url, method=method,
            data=json.dumps(body).encode() if body else None,
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "amv-upload",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode()
                if not raw.strip():
                    return r.status, {}  # 204 等空响应
                return r.status, json.loads(raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            if e.code == 403 and attempt < 3:
                time.sleep(10 + attempt * 10)
                continue
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"raw": raw[:200]}
        except Exception as e:
            if attempt < 3:
                time.sleep(5)
                continue
            return -1, {"error": str(e)[:200]}
    return -1, {"error": "retries exhausted"}


def upload(rel):
    """rel: 仓库内相对路径（如 scripts/update_cloud.py）。422 sha 竞争自动重试。"""
    path = os.path.join(BASE, *rel.split("/"))
    with open(path, "rb") as f:
        content = base64.b64encode(f.read()).decode()
    for attempt in range(4):
        st, cur = api("GET", f"https://api.github.com/repos/{USER}/{REPO}/contents/{rel}")
        sha = cur.get("sha") if st == 200 else None
        body = {
            "message": f"fix: {rel} hotfix",
            "content": content,
            "branch": "main",
        }
        if sha:
            body["sha"] = sha
        st, resp = api("PUT", f"https://api.github.com/repos/{USER}/{REPO}/contents/{rel}", body)
        if st in (200, 201):
            log(f"upload {rel}: HTTP {st} OK")
            return True
        if st in (409, 422):
            log(f"upload {rel}: HTTP {st} (sha 竞争/限流)，重试 {attempt + 1}/4")
            time.sleep(15 + attempt * 10)
            continue
        log(f"upload {rel}: HTTP {st} " + json.dumps(resp)[:200])
        return False
    return False


def main():
    open(LOG, "w", encoding="utf-8").close()
    log("API 上传开始")
    targets = ["app.js", "app21.js", "index.html", "index2.html", "app-data.js", "app-data.js.gz", "d2.js.gz", "echarts.min.js",
               "live.html", "live_data.json",
               "realtime-quote.js", "live-quote-bar.js",
               "favicon.svg", "manifest.json", "robots.txt", "sitemap.xml", "404.html", ".nojekyll",
               "PATCH-NOTES.md",
               "scripts/update_cloud.py", "scripts/news_update.py",
               "scripts/live_update.py",
               ".github/workflows/daily.yml", ".github/workflows/news.yml",
               ".github/workflows/light.yml", ".github/workflows/live.yml",
               ".github/workflows/deploy.yml",
               "dispatch_batch.py",
               "data/amv_hist.json", "stock_list.json", "data/data.json",
               "data/official_0amv.csv", "data/official_znz0.csv",
               "tdx_pick_a.txt", "industry_map.json", "concept_blocks.json"]
    # CI 生成的文件：由仓库里的 Actions 写入，绝不能用本地旧副本覆盖。
    # live_data.json 每 15 分钟由 live.yml 刷新；app-data.js / d2.js.gz / stock_list.json
    # 由 update_cloud.py 生成；concept_blocks.json 由 live_update.py 生成。
    # 2026-11-02 事故：从旧本地目录跑本脚本，把线上 live_data.json 覆盖成了 10-15 的旧文件，
    # 实盘页「市场情绪」因此显示 上涨 0 / 下跌 0 / 平盘 5575。
    CI_MANAGED = {
        "live_data.json", "app-data.js", "app-data.js.gz", "d2.js.gz",
        "stock_list.json", "concept_blocks.json", "data/data.json",
    }
    ok_all = True
    skipped_ci = []
    for rel in targets:
        if rel in CI_MANAGED:
            skipped_ci.append(rel)
            continue
        if not os.path.exists(os.path.join(BASE, *rel.split("/"))):
            log(f"skip missing: {rel}")
            continue
        ok_all &= upload(rel)
    if ok_all and not os.environ.get("SKIP_DISPATCH"):
        st, resp = api("POST",
                       f"https://api.github.com/repos/{USER}/{REPO}/actions/workflows/daily.yml/dispatches",
                       {"ref": "main"})
        log(f"workflow dispatch: HTTP {st}")
    if skipped_ci:
        log("跳过 CI 管理文件: " + ", ".join(skipped_ci))
        log("全部成功")
        return 0
    log("有失败，未触发 workflow")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
