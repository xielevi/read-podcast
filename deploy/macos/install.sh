#!/usr/bin/env bash
set -euo pipefail

# macOS reference deployment：zero-config fresh install。
#
#   git clone … && deploy/macos/install.sh
#
# 安装两个 product LaunchAgent（Transcription Service + 本机 MLX Whisper 引擎）。
# 不创建 application config、不写入任何 secret、不配置 Tunnel / Cloudflare：
# 控制面（endpoint、Access、精修、凭据）全部属于 Cloudflare。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SERVICE_DIR="${REPO_DIR}/transcription_service"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/Library/Logs/ReadPodcastEdge"
DATA_DIR="${HOME}/Library/Application Support/ReadPodcastEdge"
SERVICES=(transcription mlx)

echo "=== 安装 Read Podcast Transcription Service 与 MLX 引擎 ==="
echo "仓库目录:   ${REPO_DIR}"
echo "日志目录:   ${LOG_DIR}"
echo "运行态数据: ${DATA_DIR}"

# ── 依赖检查：缺什么就明确失败，绝不 fallback 到占位实现 ──
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ 本脚本只支持 macOS（当前 $(uname -s)）" >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "❌ 本机 MLX Whisper 需要 Apple Silicon（当前 $(uname -m)）" >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "❌ 未安装 uv：请先安装 https://docs.astral.sh/uv/ 后重试" >&2
  exit 1
fi

mkdir -p "${LAUNCH_AGENTS_DIR}" "${LOG_DIR}" "${DATA_DIR}"
chmod +x "${SERVICE_DIR}/bin/run-service" "${SERVICE_DIR}/bin/run-mlx"

echo "1. 同步 Python 依赖 (uv sync --locked)…"
uv sync --directory "${SERVICE_DIR}" --locked

echo "2. 校验本机 MLX Whisper 引擎可用…"
if ! uv run --directory "${SERVICE_DIR}" python -c "import mlx_whisper" >/dev/null 2>&1; then
  echo "❌ 无法导入 mlx_whisper：请检查 uv sync 的输出" >&2
  exit 1
fi

echo "3. 安装 LaunchAgents…"
for svc in "${SERVICES[@]}"; do
  template="${SCRIPT_DIR}/com.readpodcast.${svc}.plist.template"
  target="${LAUNCH_AGENTS_DIR}/com.readpodcast.${svc}.plist"
  sed -e "s|__REPO_DIR__|${REPO_DIR}|g" \
      -e "s|__LOG_DIR__|${LOG_DIR}|g" \
      "${template}" > "${target}"
  echo "   已生成 ${target}"
done

echo "4. 启动服务…"
DOMAIN="gui/$(id -u)"
for svc in "${SERVICES[@]}"; do
  label="com.readpodcast.${svc}"
  plist="${LAUNCH_AGENTS_DIR}/${label}.plist"
  # bootout 是异步的：必须等旧 job 真正消失，否则紧接着的 bootstrap 会以 EIO 失败。
  launchctl bootout "${DOMAIN}/${label}" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1 || break
    sleep 0.5
  done
  launchctl bootstrap "${DOMAIN}" "${plist}"
  launchctl enable "${DOMAIN}/${label}"
  echo "   已加载 ${label}"
done

echo "5. 本机健康检查…"
for _ in $(seq 1 30); do
  if curl -sf --max-time 3 "http://127.0.0.1:28100/health" >/dev/null && curl -sf --max-time 3 "http://127.0.0.1:21567/health" >/dev/null; then
    break
  fi
  sleep 1
done
"${SCRIPT_DIR}/status.sh"
