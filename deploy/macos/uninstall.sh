#!/usr/bin/env bash
set -euo pipefail

# 卸载两个 LaunchAgent。运行态数据与日志保留（Mac 上没有任何 application config / secret 需要处理）。

LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/Library/Logs/ReadPodcastEdge"
DATA_DIR="${HOME}/Library/Application Support/ReadPodcastEdge"

echo "=== 卸载 Read Podcast Transcription Service 与 MLX 引擎 ==="

for svc in transcription mlx; do
  label="com.readpodcast.${svc}"
  plist="${LAUNCH_AGENTS_DIR}/${label}.plist"
  if [[ -f "${plist}" ]]; then
    echo "正在卸载 ${label}…"
    launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
    rm -f "${plist}"
    echo "已移除 ${plist}"
  else
    echo "未找到 ${plist}，跳过"
  fi
done

echo "服务已停止并取消注册。"
echo "保留：运行态数据 ${DATA_DIR}、日志 ${LOG_DIR}"
