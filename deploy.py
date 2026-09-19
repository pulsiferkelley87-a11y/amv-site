# -*- coding: utf-8 -*-
"""云端部署脚本 v2（安全版）。

- token 从环境变量 GH_TOKEN 读取，绝不写入文件
- git 使用 openssl TLS 后端（规避 Windows schannel 受限问题）
- 输出编码兼容 GBK/UTF-8
"""
import json
import os
import subprocess
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(BASE, "deploy_log.txt")

TOKEN = ""
_tok_file = os.path.join(BASE, ".gh_token")
if os.path.exists(_tok_file):
    with open(_tok_file, encoding="utf-8") as _f:
        TOKEN = _f.read().strip()
if not TOKEN:
    TOKEN = os.environ.get("GH_TOKEN", "")
USER = "pulsiferkelley87-a11y"
REPO = "amv-site"

GIT = "git -c http.sslBackend=openssl"


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(line, flush=True)


def run(cmd, cwd=BASE, timeout=420):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, shell=True, timeout=timeout)
    for raw in (p.stdout, p.stderr):
        if not raw:
            continue
        for enc in ("utf-8", "gbk", "latin-1"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            text = str(raw)
        tail = text.strip()[-600:]
        if tail:
            log("  " + tail.replace("\n", "\n  "))
    return p.returncode


def api(method, url, body=None):
    import urllib.request
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body else None,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "amv-setup",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main():
    open(LOG, "w", encoding="utf-8").close()
    log("开始部署")
    if not TOKEN:
        log("ERROR: 环境变量 GH_TOKEN 未设置")
        return 1

    os.chdir(BASE)
    # 1. git 初始化（.git 已由调用方重建过，这里确保干净）
    run(f'{GIT} init')
    run(f'{GIT} config user.name "amv-bot"')
    run(f'{GIT} config user.email "bot@users.noreply.github.com"')
    run(f'{GIT} add -A')
    rc = run(f'{GIT} commit -m "init amv-site"')
    if rc not in (0, 1):
        log("commit 失败，继续尝试")

    # 2. 建仓库（已存在则跳过）
    st, body = api("GET", f"https://api.github.com/repos/{USER}/{REPO}")
    if st == 200:
        log("仓库已存在")
    else:
        st, body = api("POST", "https://api.github.com/user/repos",
                       {"name": REPO, "description": "0AMV 活跃市值监测台",
                        "public": True, "auto_init": False})
        log(f"建仓库: HTTP {st}")
        if st not in (201, 422):
            log("建仓库响应: " + body[:300])

    # 3. push（token 仅存在于进程环境，不落盘）
    remote = f"https://{TOKEN}@github.com/{USER}/{REPO}.git"
    run(f'{GIT} remote remove origin')
    run(f'{GIT} remote add origin "{remote}"')
    run(f'{GIT} branch -M main')
    rc = run(f'{GIT} push -u origin main --force')
    log(f"push exit={rc}")
    # 立即抹掉 remote 里的 token（不留痕迹）
    run(f'{GIT} remote set-url origin "https://github.com/{USER}/{REPO}.git"')

    # 4. 开 Pages（Actions 模式）
    st, body = api("POST", f"https://api.github.com/repos/{USER}/{REPO}/pages",
                   {"build_type": "workflow"})
    log(f"Pages: HTTP {st}" + ("" if st in (201, 409) else " " + body[:200]))

    # 5. 触发首次云端更新
    st, body = api("POST",
                   f"https://api.github.com/repos/{USER}/{REPO}/actions/workflows/daily.yml/dispatches",
                   {"ref": "main"})
    log(f"触发 workflow: HTTP {st}")

    log("部署结束")
    return rc


if __name__ == "__main__":
    sys.exit(main())
