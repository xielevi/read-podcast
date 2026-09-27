#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${HOME}/Library/Logs/ReadPodcastEdge"
TARGET="${1:-transcription}"

case "${TARGET}" in
  transcription)
    FILE="${LOG_DIR}/transcription.log"
    ;;
  transcription-err)
    FILE="${LOG_DIR}/transcription.stderr.log"
    ;;
  mlx)
    FILE="${LOG_DIR}/mlx.log"
    ;;
  mlx-err)
    FILE="${LOG_DIR}/mlx.stderr.log"
    ;;
  *)
    echo "用法: $0 [transcription|transcription-err|mlx|mlx-err]"
    exit 1
    ;;
esac

if [[ ! -f "${FILE}" ]]; then
  echo "日志文件尚不存在: ${FILE}"
  exit 0
fi

echo "正在跟踪日志: ${FILE} (Ctrl+C 退出)..."
tail -f "${FILE}"
