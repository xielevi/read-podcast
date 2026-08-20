#!/usr/bin/env bash
# Read Podcast 一键启动脚本（macOS Apple Silicon）
# 作用：同时启动语音转录后端（MLX）与网页应用，只用一个终端窗口。
# 关闭：在本窗口按 Ctrl-C，两个服务会一起停止。
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

info() { printf '\033[1;34m▶ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

APP_PORT="${READ_PODCAST_PORT:-${PODCAST2MD_PORT:-28000}}"
MLX_PORT="${READ_PODCAST_MLX_PORT:-${PODCAST2MD_MLX_PORT:-21567}}"
export READ_PODCAST_MLX_HOST=127.0.0.1
export READ_PODCAST_TRANSCRIPTION_API_URL="http://127.0.0.1:${MLX_PORT}/transcribe"
export READ_PODCAST_TRANSCRIPTION_SHARED_AUDIO_ROOT=""

command -v uv >/dev/null 2>&1 || die "找不到 uv，请先运行 ./scripts/install.sh"

# 首次运行时补全配置，保证脚本可独立使用
[ -f .env ] || cp .env.example .env
mkdir -p config
if [ ! -f config/config.yaml ]; then
  cat > config/config.yaml <<YAML
# ── 你的配置就写在这个文件里 ──────────────────────────────
# 由 start.sh 首次运行自动生成，之后不会被覆盖，git pull 也不会动它。
# 手动编辑，或用网页右上角的「设置」面板，两者作用于同一份配置。
#
# 只写你想改的项即可，其余自动使用内置默认值。
# 可用选项与示例见 modules/config.default.yaml（那是只读参考，不要直接改它）。
# 密钥不写这里，写同目录的 secrets.env。
#
# 换 AI 服务商就改下面这段（去掉行首 # 即可启用）：
# refiner:
#   api_base: https://api.deepseek.com/v1
#   model: deepseek-chat
#
# 改成稿保存位置：
# paths:
#   obsidian_markdown_dir: /Users/你的用户名/Obsidian/播客

# 让网页应用连接本机上的语音转录后端；如需分离部署请改成对方地址。
transcription:
  api_url: http://127.0.0.1:${MLX_PORT}/transcribe
  shared_audio_root: ""
YAML
fi

# 确保依赖已安装（已安装则很快返回）
info "检查依赖…"
uv sync --extra mlx >/dev/null

MLX_PID=""
cleanup() {
  printf '\n'
  info "正在停止服务…"
  [ -n "$MLX_PID" ] && kill "$MLX_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

info "启动语音转录后端（首次会下载模型，可能需要几分钟）…"
uv run --no-sync python -m scripts.mlx_backend &
MLX_PID=$!

info "等待转录后端就绪…"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${MLX_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  # 后端进程若已退出，直接报错
  kill -0 "$MLX_PID" 2>/dev/null || die "转录后端启动失败，请查看上方日志。"
  sleep 1
done

info "启动网页应用…"
( sleep 2; command -v open >/dev/null 2>&1 && open "http://127.0.0.1:${APP_PORT}/" ) &

printf '\n\033[1;32m打开浏览器访问：http://127.0.0.1:%s/\033[0m\n\n' "$APP_PORT"

# 前台运行应用；退出时 trap 会一并停止转录后端
uv run --no-sync uvicorn app.standalone:app --host 127.0.0.1 --port "$APP_PORT"
