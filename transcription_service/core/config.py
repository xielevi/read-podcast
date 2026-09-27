"""Transcription Service 的运行配置：built-in defaults + 平台路径。

零配置设计：本服务**没有**任何用户维护的配置文件，也没有任何 application secret。

- 转录引擎固定为 reference deployment 的本机 MLX Whisper（``MLX_ENDPOINT``，端口 21567）；
- 运行时默认（下载上限 / 并发 / 超时 / 活跃请求上限 / 结果 TTL）全部是程序内建默认值，
  不是 deployment configuration；
- 唯一的显式覆盖是数据 / 日志目录（测试隔离用），只从真实 process environment 读取——
  不存在 .env、YAML 配置或任何第二配置中心。

远程认证由 Cloudflare Access 承担；真正随任务变化的参数（语言）由 Cloudflare 随请求下发。
本机不保存任何 Cloudflare / R2 / GitHub / 精修凭据。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

CORE_DIR = Path(__file__).resolve().parent

# ── reference deployment 的固定拓扑：同机两个进程 ──
# Transcription Service 监听 127.0.0.1:28100（见 bin/run-service），引擎是 127.0.0.1:21567。
MLX_ENDPOINT = "http://127.0.0.1:21567"

# ── 运行时 built-in defaults ──
MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 单个音频源上限；Cloudflare 可用 source.max_bytes 收紧
DOWNLOAD_CONNECT_TIMEOUT_SECONDS = 15
DOWNLOAD_READ_TIMEOUT_SECONDS = 120  # 单次读取的停顿上限（不是整个文件的总时长硬顶）
DOWNLOAD_CONCURRENCY = 2
MAX_ACTIVE_REQUESTS = 16  # 同时存在（排队 + 执行中）的请求上限；超过返回 429
RESULT_TTL_SECONDS = 24 * 3600  # 终态请求（含已完成结果）的本地保留时间；过期即回收


def default_data_dir() -> Path:
    """运行态数据目录：显式 ``READ_PODCAST_TRANSCRIPTION_DATA`` 优先（测试隔离）；否则按平台惯例。"""
    explicit = os.environ.get("READ_PODCAST_TRANSCRIPTION_DATA", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    if sys.platform == "darwin":
        return (Path.home() / "Library" / "Application Support" / "ReadPodcastEdge").resolve()
    return (Path.home() / ".local" / "share" / "ReadPodcastEdge").resolve()


def default_log_dir() -> Path:
    """日志目录：显式 ``READ_PODCAST_LOG_DIR`` 优先；否则按宿主平台的惯例位置。"""
    explicit = os.environ.get("READ_PODCAST_LOG_DIR", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    if sys.platform == "darwin":
        return (Path.home() / "Library" / "Logs" / "ReadPodcastEdge").resolve()
    return (Path.home() / ".local" / "state" / "ReadPodcastEdge").resolve()


DATA_DIR = default_data_dir()
