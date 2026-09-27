"""Transcription Service 的运行配置：built-in defaults + 平台路径。

零配置设计：本服务**没有**任何用户维护的配置文件，也没有任何 application secret。

- 转录引擎按平台内建选择（Apple Silicon 默认本机 MLX Whisper，其余平台默认进程内
  Faster-Whisper），``READ_PODCAST_TRANSCRIPTION_ENGINE`` 可强制指定；Faster-Whisper 的
  模型 / 设备 / 精度 / 线程数同样只有内建默认值 + 环境变量覆盖，没有第二配置中心；
- 运行时默认（下载上限 / 并发 / 超时 / 活跃请求上限 / 结果 TTL）全部是程序内建默认值，
  不是 deployment configuration；
- 唯一的显式覆盖是数据 / 日志目录（测试隔离用），只从真实 process environment 读取——
  不存在 .env、YAML 配置或任何第二配置中心。

远程认证由 Cloudflare Access 承担；真正随任务变化的参数（语言）由 Cloudflare 随请求下发。
本机不保存任何 Cloudflare / R2 / GitHub / 精修凭据。
"""
from __future__ import annotations

import os
import platform
import sys
from dataclasses import dataclass
from pathlib import Path

CORE_DIR = Path(__file__).resolve().parent

# ── reference deployment 的固定拓扑：同机两个进程 ──
# Transcription Service 监听 127.0.0.1:28100（见 bin/run-service），引擎是 127.0.0.1:21567。
MLX_ENDPOINT = "http://127.0.0.1:21567"

# ── 转录引擎选择：内建默认 + 环境变量强制 ──
ENGINE_MLX = "mlx"
ENGINE_FASTER_WHISPER = "faster-whisper"
ENGINE_OPENAI_PROXY = "openai-proxy"
ENGINE_ENV_VAR = "READ_PODCAST_TRANSCRIPTION_ENGINE"


def resolve_engine() -> str:
    """解析转录引擎：显式环境变量优先；auto（默认）按平台选择。

    Apple Silicon（darwin + arm64）默认 MLX——reference deployment 的本机引擎；
    其余平台（Linux / Windows / NAS / 容器，含 Intel Mac）默认进程内 Faster-Whisper。
    openai-proxy 为显式代理模式，代理任意 OpenAI 兼容云端转录接口。
    非法值宁可启动即报错，也不悄悄回退到「看似正常」的错误引擎。
    """
    explicit = os.environ.get(ENGINE_ENV_VAR, "").strip().lower()
    if explicit and explicit != "auto":
        if explicit not in (ENGINE_MLX, ENGINE_FASTER_WHISPER, ENGINE_OPENAI_PROXY):
            raise ValueError(
                f"{ENGINE_ENV_VAR} 必须是 'auto' / 'mlx' / 'faster-whisper' / 'openai-proxy'，收到 {explicit!r}"
            )
        return explicit
    if sys.platform == "darwin" and platform.machine() == "arm64":
        return ENGINE_MLX
    return ENGINE_FASTER_WHISPER

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


# ── Faster-Whisper 引擎内建默认值（只允许环境变量逐项覆盖；没有配置文件） ──
DEFAULT_FASTER_WHISPER_MODEL = "large-v3-turbo"
DEFAULT_FASTER_WHISPER_DEVICE = "auto"  # CUDA 可用则用 GPU，否则 CPU
DEFAULT_FASTER_WHISPER_COMPUTE_TYPE = "int8"  # CPU / CUDA 通用，内存占用小（legacy 参考实现同款）
DEFAULT_FASTER_WHISPER_CPU_THREADS = max(1, os.cpu_count() or 4)


@dataclass(frozen=True)
class FasterWhisperOptions:
    model: str
    device: str
    compute_type: str
    cpu_threads: int


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"{name} 必须是整数，收到 {raw!r}") from None
    if value < 0:
        raise ValueError(f"{name} 不能为负数")
    return value


def faster_whisper_options() -> FasterWhisperOptions:
    """Faster-Whisper 运行参数：内建默认值，仅可用环境变量逐项覆盖。"""
    return FasterWhisperOptions(
        model=os.environ.get("READ_PODCAST_TRANSCRIPTION_MODEL", "").strip() or DEFAULT_FASTER_WHISPER_MODEL,
        device=os.environ.get("READ_PODCAST_TRANSCRIPTION_DEVICE", "").strip() or DEFAULT_FASTER_WHISPER_DEVICE,
        compute_type=os.environ.get("READ_PODCAST_TRANSCRIPTION_COMPUTE_TYPE", "").strip() or DEFAULT_FASTER_WHISPER_COMPUTE_TYPE,
        cpu_threads=_env_int("READ_PODCAST_TRANSCRIPTION_CPU_THREADS", DEFAULT_FASTER_WHISPER_CPU_THREADS),
    )


# ── OpenAI-Proxy 引擎内建默认值（只允许环境变量逐项覆盖；没有配置文件） ──
DEFAULT_OPENAI_PROXY_API_BASE = "https://api.openai.com/v1"
DEFAULT_OPENAI_PROXY_MODEL = "whisper-1"
DEFAULT_OPENAI_PROXY_CHUNK_SIZE_MB = 24  # 上游上限通常为 25MB，留 1MB 余量
DEFAULT_OPENAI_PROXY_OVERLAP_SECONDS = 2.0  # 分段重叠时长（秒）
DEFAULT_OPENAI_PROXY_TIMEOUT_SECONDS = 180  # 单段上传超时时间（秒）
DEFAULT_OPENAI_PROXY_MAX_RETRIES = 3  # 单段失败最大重试次数


@dataclass(frozen=True)
class OpenAIProxyOptions:
    api_base: str
    api_key: str
    model: str
    chunk_size_mb: int = DEFAULT_OPENAI_PROXY_CHUNK_SIZE_MB
    overlap_seconds: float = DEFAULT_OPENAI_PROXY_OVERLAP_SECONDS
    timeout_seconds: int = DEFAULT_OPENAI_PROXY_TIMEOUT_SECONDS
    max_retries: int = DEFAULT_OPENAI_PROXY_MAX_RETRIES


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{name} 必须是数值，收到 {raw!r}") from None
    if value < 0:
        raise ValueError(f"{name} 不能为负数")
    return value


def openai_proxy_options() -> OpenAIProxyOptions:
    """OpenAI 代理模式运行参数：内建默认值，仅可用环境变量逐项覆盖。"""
    return OpenAIProxyOptions(
        api_base=os.environ.get("READ_PODCAST_OPENAI_API_BASE", "").strip() or DEFAULT_OPENAI_PROXY_API_BASE,
        api_key=os.environ.get("READ_PODCAST_OPENAI_API_KEY", "").strip() or os.environ.get("OPENAI_API_KEY", "").strip(),
        model=os.environ.get("READ_PODCAST_OPENAI_MODEL", "").strip() or os.environ.get("OPENAI_MODEL", "").strip() or DEFAULT_OPENAI_PROXY_MODEL,
        chunk_size_mb=_env_int("READ_PODCAST_OPENAI_CHUNK_SIZE_MB", DEFAULT_OPENAI_PROXY_CHUNK_SIZE_MB),
        overlap_seconds=_env_float("READ_PODCAST_OPENAI_OVERLAP_SECONDS", DEFAULT_OPENAI_PROXY_OVERLAP_SECONDS),
        timeout_seconds=_env_int("READ_PODCAST_OPENAI_TIMEOUT_SECONDS", DEFAULT_OPENAI_PROXY_TIMEOUT_SECONDS),
        max_retries=_env_int("READ_PODCAST_OPENAI_MAX_RETRIES", DEFAULT_OPENAI_PROXY_MAX_RETRIES),
    )
