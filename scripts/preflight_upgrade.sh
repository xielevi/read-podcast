#!/usr/bin/env bash
# 升级到「Cloudflare 拥有转录编排」架构（迁移 0015）之前的只读预检。
#
# 迁移本身对 active task 是安全的（转录 / 精修阶段的任务会被重新排队、由新的 Processing Workflow 接手，
# raw 已在 R2 的不会重新转录），所以这里的检查是建议性的：目的是让你在升级前看清有哪些任务正在处理，
# 最好等它们结束再升级，避免多花一次转录 / 精修。只读，不修改任何数据。
#
# 用法：scripts/preflight_upgrade.sh [--local]      默认检查 --remote（生产 D1）
set -euo pipefail

TARGET="--remote"
[[ "${1:-}" == "--local" ]] && TARGET="--local"

SQL="SELECT id, status, progress, substr(episode_title, 1, 40) AS title, updated_at FROM tasks WHERE status IN ('waiting_worker', 'downloading', 'transcribing', 'refining') ORDER BY created_at"

echo "=== 升级预检（${TARGET#--}）：仍在处理中的任务 ==="
OUTPUT="$(npx wrangler d1 execute DB "${TARGET}" --json --command "${SQL}")"
COUNT="$(printf '%s' "${OUTPUT}" | python3 -c '
import json, sys
text = sys.stdin.read()
rows = json.loads(text[text.index("["):])[0]["results"]
for row in rows:
    print("  {id}  {status:<14} {progress:>3}%  {title}  (updated {updated_at})".format(**row), file=sys.stderr)
print(len(rows))
')"

if [[ "${COUNT}" == "0" ]]; then
  echo "没有处理中的任务：可以直接升级。"
else
  echo "共 ${COUNT} 个处理中的任务。迁移会把它们安全地重新排队（不会丢失，也不会成为 zombie），"
  echo "但会多消耗一次转录 / 精修；建议等待它们结束后再升级。"
  exit 1
fi
