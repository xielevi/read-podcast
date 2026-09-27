#!/usr/bin/env bash
# Cloudflare / D1 升级前的只读预检。
#
# 列出当前任务状态机中的所有 active task；脚本本身不修改数据。迁移是否会重排、
# 保留或拒绝 active task 由对应 migration 决定，因此升级前应先看 release notes，
# 并尽量等这些任务完成后再应用 schema / workflow 变更。
#
# 用法：scripts/preflight_upgrade.sh [--local]      默认检查 --remote（生产 D1）
set -euo pipefail

TARGET="--remote"
[[ "${1:-}" == "--local" ]] && TARGET="--local"

SQL="SELECT id, status, progress, substr(episode_title, 1, 40) AS title, updated_at FROM tasks WHERE status IN ('queued', 'transcribing', 'refining', 'finalizing') ORDER BY created_at"

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
  echo "共 ${COUNT} 个处理中的任务。请先查看目标版本的 migration / release notes；"
  echo "建议等待它们结束后再升级，避免在执行中途切换 schema 或 workflow 代码。"
  exit 1
fi
