#!/usr/bin/env bash
set -euo pipefail

# 只检查本机：两个 LaunchAgent 的注册状态 + 本机健康端点 + 运行态数据与日志。
# 远程链路（Cloudflare → Access → Tunnel → 本机）由 Cloudflare Settings 的
# “Test Transcription Service” 验证，本脚本不检查 Tunnel / Access / 任务状态。
#
# 退出码：两个服务全部健康 → 0；任何一个未注册或不健康 → 1
# （install.sh / restart.sh 以本脚本收尾，因此自然继承失败语义）。

LOG_DIR="${HOME}/Library/Logs/ReadPodcastEdge"
DATA_DIR="${HOME}/Library/Application Support/ReadPodcastEdge"
SERVICE_PORT=28100
MLX_PORT=21567
LABELS=(com.readpodcast.transcription com.readpodcast.mlx)

healthy=1

echo "=== Read Podcast Transcription Service 本机状态 ==="
echo ""
echo "--- launchd ---"
for label in "${LABELS[@]}"; do
  if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
    pid="$(launchctl print "gui/$(id -u)/${label}" 2>/dev/null | awk '/^\tpid = /{print $3}')"
    if [[ -n "${pid}" ]]; then
      echo "✅ ${label}（pid ${pid}）"
    else
      echo "❌ ${label} 已注册但进程未运行"
      healthy=0
    fi
  else
    echo "❌ ${label} 未注册（先运行 install.sh）"
    healthy=0
  fi
done

echo ""
echo "--- 本机健康端点 ---"
if curl -sf --max-time 3 "http://127.0.0.1:${SERVICE_PORT}/health"; then
  echo ""
else
  echo "❌ Transcription Service 无法连接 (127.0.0.1:${SERVICE_PORT})"
  healthy=0
fi
if curl -sf --max-time 3 "http://127.0.0.1:${MLX_PORT}/health"; then
  echo ""
else
  echo "❌ MLX Whisper 引擎无法连接 (127.0.0.1:${MLX_PORT})"
  healthy=0
fi

echo ""
echo "--- 运行态数据目录 ---"
echo "${DATA_DIR}"
ls -la "${DATA_DIR}" 2>/dev/null || echo "（尚无运行态数据）"

echo ""
echo "--- 最近 Transcription Service 日志 (${LOG_DIR}/transcription.log) ---"
if [[ -f "${LOG_DIR}/transcription.log" ]]; then
  tail -n 5 "${LOG_DIR}/transcription.log"
else
  echo "暂无 transcription.log"
fi

echo ""
echo "--- 最近 MLX 日志 (${LOG_DIR}/mlx.log) ---"
if [[ -f "${LOG_DIR}/mlx.log" ]]; then
  tail -n 5 "${LOG_DIR}/mlx.log"
else
  echo "暂无 mlx.log"
fi

echo ""
echo "--- launchd stderr（启动失败才写内容）---"
for name in transcription mlx; do
  file="${LOG_DIR}/${name}.stderr.log"
  if [[ -s "${file}" ]]; then
    echo "[${name}.stderr.log]"
    tail -n 5 "${file}"
  fi
done
echo "（无输出表示没有启动错误）"

echo ""
if [[ "${healthy}" == "1" ]]; then
  echo "✅ 两个本机服务均健康"
  exit 0
fi
echo "❌ 至少一个本机服务未注册或不健康"
exit 1
