#!/usr/bin/env bash
# 仅启动语音转录后端（MLX），配合 Docker 部署使用。
# Docker 里的网页应用会通过 host.docker.internal:21567 连接本脚本启动的服务。
# 关闭：在本窗口按 Ctrl-C。
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

command -v uv >/dev/null 2>&1 || { echo "找不到 uv，请先运行 ./scripts/install.sh" >&2; exit 1; }

[ -f .env ] || cp .env.example .env

if ! uv run --no-sync python -c \
  'from scripts.mlx_backend import API_TOKEN; raise SystemExit(0 if API_TOKEN else 1)'; then
  echo "Docker 访问 MLX 需要 Token：请先在 .env 设置 PODCAST2MD_WHISPER_API_TOKEN。" >&2
  exit 1
fi
export PODCAST2MD_MLX_HOST=0.0.0.0

printf '\033[1;34m▶ 启动语音转录后端（首次会下载模型，可能需要几分钟）…\033[0m\n'
exec uv run --no-sync python -m scripts.mlx_backend
