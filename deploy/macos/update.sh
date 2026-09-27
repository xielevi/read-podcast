#!/usr/bin/env bash
set -euo pipefail

# 升级：要求 checkout 干净 → git pull --ff-only → uv sync --locked → Python 测试 → 重启 → 本机健康检查。
# 工作树有未提交改动时直接失败：dirty 状态说明有人在本机手改了代码，先弄清楚再升级。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SERVICE_DIR="${REPO_DIR}/transcription_service"

cd "${REPO_DIR}"

echo "=== 更新 Read Podcast Transcription Service ==="

if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ 工作树不干净，拒绝升级（先提交或丢弃本地改动）：" >&2
  git status --short >&2
  exit 1
fi

echo "1. 拉取最新代码 (git pull --ff-only)…"
git pull --ff-only

echo "2. 同步 Python 依赖 (uv sync --locked)…"
uv sync --directory "${SERVICE_DIR}" --locked

echo "3. 运行服务端测试…"
UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/read-podcast-edge-uv-cache}" uv run --directory "${SERVICE_DIR}" pytest -q

echo "4. 重启运行态服务…"
"${SCRIPT_DIR}/restart.sh"

echo ""
echo "--- 升级后仓库状态 ---"
git status --porcelain || true
echo "（无输出表示 checkout 仍然干净）"
