# -*- coding: utf-8 -*-
"""github_publish.py — 通过 GitHub Git Data API 推送当前 git 仓库内容
适用场景:github.com 主站不可达(被墙),但 api.github.com 可用。
用法:
  python tools/github_publish.py --token-file <token文件路径> [--repo OWNER/REPO] [--message "提交说明"]
说明:远端提交由 API 生成,与本地提交的 sha 不同;以后更新始终用本脚本同步即可。
"""
import argparse, base64, json, os, subprocess, sys, urllib.error, urllib.request

REPO_DEFAULT = "Hayden-H-cmyht/stormcam"
REPO = REPO_DEFAULT

class ApiError(Exception):
    def __init__(self, code, detail):
        super().__init__(f"{code}: {detail}")
        self.code = code

def api(token, method, path, body=None):
    url = f"https://api.github.com/repos/{REPO}/{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, method=method, data=data, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "stormcam-publisher",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            txt = r.read()
            return json.loads(txt) if txt else {}
    except urllib.error.HTTPError as e:
        raise ApiError(e.code, e.read().decode(errors="replace")[:300])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--repo", default=REPO_DEFAULT)
    ap.add_argument("--message", default="update from github_publish.py")
    args = ap.parse_args()
    global REPO
    REPO = args.repo
    token = open(args.token_file, encoding="utf-8").read().strip()

    files = subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split()
    if not files:
        raise SystemExit("[!] git ls-files 为空,请在仓库根目录运行")
    print(f"共 {len(files)} 个文件,上传 blobs...")
    entries = []
    for f in files:
        with open(f, "rb") as fh:
            b = api(token, "POST", "git/blobs", {
                "content": base64.b64encode(fh.read()).decode(),
                "encoding": "base64",
            })
        entries.append({"path": f, "mode": "100644", "type": "blob", "sha": b["sha"]})
        print("  ✓", f)

    # 已有 main 分支则在其上追加提交,否则初始化
    parent, base_tree = None, None
    try:
        ref = api(token, "GET", "git/ref/heads/main")
        parent = ref["object"]["sha"]
        base_tree = api(token, "GET", f"git/commits/{parent}")["tree"]["sha"]
    except ApiError as e:
        if e.code != 404:
            raise  # 非"分支不存在"的真错误,如实报出
    tree = {"tree": entries}
    if base_tree:
        tree["base_tree"] = base_tree
    t = api(token, "POST", "git/trees", tree)
    c = api(token, "POST", "git/commits", {
        "message": args.message, "tree": t["sha"], "parents": [parent] if parent else [],
    })
    if parent:
        api(token, "PATCH", "git/refs/heads/main", {"sha": c["sha"]})
    else:
        api(token, "POST", "git/refs", {"ref": "refs/heads/main", "sha": c["sha"]})
    print(f"\n✅ 已推送到 {args.repo} main @ {c['sha'][:10]}")
    print(f"   https://github.com/{args.repo}/commit/{c['sha']}")

if __name__ == "__main__":
    main()
