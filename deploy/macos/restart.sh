#!/usr/bin/env bash
set -euo pipefail

# 重启两个 product LaunchAgent（先引擎、后 Transcription Service），然后做本机健康检查。
# reference deployment 固定为本机 MLX，没有 backend detection。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"

echo "=== 重启 Read Podcast Transcription Service 与 MLX 引擎 ==="

DOMAIN="gui/$(id -u)"
for svc in mlx transcription; do
  label="com.readpodcast.${svc}"
  plist="${LAUNCH_AGENTS_DIR}/${label}.plist"
  if [[ ! -f "${plist}" ]]; then
    echo "❌ 未找到 ${plist}（先运行 install.sh）" >&2
    exit 1
  fi
  echo "正在重启 ${label}…"
  # bootout 是异步的：必须等旧 job 真正消失，否则紧接着的 bootstrap 会以 EIO 失败。
  launchctl bootout "${DOMAIN}/${label}" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1 || break
    sleep 0.5
  done
  launchctl bootstrap "${DOMAIN}" "${plist}"
  launchctl enable "${DOMAIN}/${label}"
done

echo ""
sleep 2
"${SCRIPT_DIR}/status.sh"
