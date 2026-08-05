#!/usr/bin/env bash
# Read Podcast 一键安装脚本（macOS Apple Silicon）
# 作用：检查环境 → 安装 ffmpeg 与 uv → 安装项目依赖 → 生成初始配置。
# 只需运行一次；之后用 ./scripts/start.sh 启动。
set -euo pipefail

cd "$(dirname "$0")/.."

info() { printf '\033[1;34m▶ %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

info "检查电脑型号…"
if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  die "本工具的语音转录只支持 Apple 芯片的 Mac（M1/M2/M3/M4）。当前设备不满足，无法安装。"
fi
ok "Apple 芯片 Mac"

info "检查 ffmpeg（音频处理工具）…"
if ! command -v ffmpeg >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    die "需要先安装 Homebrew，请打开 https://brew.sh 按说明安装后重新运行本脚本。"
  fi
  info "正在通过 Homebrew 安装 ffmpeg，可能需要几分钟…"
  brew install ffmpeg
fi
ok "ffmpeg 已就绪"

info "检查 uv（Python 运行环境管理器）…"
if ! command -v uv >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || die "需要 Homebrew 安装 uv，请先按 https://brew.sh 的说明安装。"
  info "正在通过 Homebrew 安装 uv…"
  brew install uv
fi
command -v uv >/dev/null 2>&1 || die "uv 安装后仍无法找到，请关闭终端重新打开后再运行本脚本。"
ok "uv 已就绪"

info "安装项目依赖（首次较慢，请耐心等待）…"
uv sync --extra mlx
ok "依赖安装完成"

info "生成配置文件…"
[ -f .env ] || cp .env.example .env
mkdir -p config
ok "配置文件已生成"

cat <<'MSG'

──────────────────────────────────────────────
安装完成！还差最后一步：填入 AI 精修服务的 Key。

1. 用文本编辑器打开项目里的 .env 文件。
2. 在 REFINER_API_KEY= 后面粘贴你的 Key（如何申请见 README「申请 AI Key」一节）。
3. 保存后运行：  ./scripts/start.sh
──────────────────────────────────────────────
MSG
