"""转录引擎适配（Transcription Engine adapter）。

内建两个引擎，同属一个 ``Transcriber`` 协议（``音频文件 → 文本``，一次计算：不缓存、
不决定是否重试——失败以带稳定 ``code`` 的 ``EngineError`` 抛出，由上层如实上报给
Cloudflare，业务重试判断属于 Cloudflare）：

- **MLX**（``WhisperApiTranscriber``）：reference deployment（Apple Silicon）的本机
  原生 MLX Whisper HTTP 服务（``mlx_service``，127.0.0.1，无令牌）；
- **Faster-Whisper**（``core.faster_whisper_engine.FasterWhisperTranscriber``）：进程内
  CPU / CUDA 引擎，其余平台（Linux / Windows / NAS / 容器）的默认。

引擎选择是内建策略（见 ``core.config.resolve_engine``）：Apple Silicon 默认 MLX，其余
默认 Faster-Whisper，``READ_PODCAST_TRANSCRIPTION_ENGINE`` 可强制指定。跨机器的可替换性
仍然来自 **HTTP contract**（Windows CUDA / cloud GPU 可以实现同一个 Transcription
Service contract），不依赖调用方感知引擎差异。
"""
from __future__ import annotations

import logging
import os
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from pathlib import Path
from typing import Callable, Protocol

import httpx

from core.config import ENGINE_MLX, ENGINE_OPENAI_PROXY, MLX_ENDPOINT, resolve_engine

logger = logging.getLogger(__name__)


class TranscriptionResult:
    def __init__(self, text: str, language: str | None = None, segments: list[dict] | None = None, duration: float | None = None):
        self.text = text
        self.language = language
        self.segments = segments or []
        self.duration = duration

    @classmethod
    def from_dict(cls, data: dict) -> "TranscriptionResult":
        return cls(
            text=data.get("text", ""),
            language=data.get("language"),
            segments=data.get("segments"),
            duration=data.get("duration"),
        )


class EngineError(RuntimeError):
    """转录引擎无法产出有效文本。``code`` 是稳定的机器可读原因，由服务原样上报。

    - ``engine_unavailable``：引擎连不上 / 超时 / 5xx（环境问题，稍后可能恢复）；
    - ``engine_failed``：引擎处理失败（其它错误）；
    - ``engine_rejected_audio``：引擎明确拒收该音频（例如超出引擎上传上限）；
    - ``transcription_empty``：引擎返回了空文本。
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _classify_http_error(exc: Exception) -> EngineError:
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in (408, 425, 429) or status >= 500:
            return EngineError("engine_unavailable", f"转录引擎返回 HTTP {status}")
        if status in (400, 413, 415, 422):
            return EngineError("engine_rejected_audio", f"转录引擎拒收音频（HTTP {status}）")
        return EngineError("engine_failed", f"转录引擎返回 HTTP {status}")
    if isinstance(exc, (httpx.TransportError, OSError)):
        return EngineError("engine_unavailable", f"无法连接转录引擎: {type(exc).__name__}")
    return EngineError("engine_failed", f"转录失败: {type(exc).__name__}: {exc}")


class Transcriber(Protocol):
    """JobManager 依赖的引擎契约（生产实现只有 ``WhisperApiTranscriber``）。"""

    def transcribe(
        self,
        audio_file: str,
        progress_callback: Callable | None = None,
        language: str | None = None,
    ) -> TranscriptionResult: ...


class WhisperApiTranscriber:
    """调用同机的原生 MLX Whisper HTTP 服务。"""

    def __init__(self, api_url: str = MLX_ENDPOINT, timeout: int = 1800):
        self.api_url = api_url.rstrip("/")
        if not self.api_url.endswith("/transcribe"):
            self.api_url += "/transcribe"
        self.timeout = timeout

    def _headers(self, request_id: str | None = None) -> dict | None:
        # MLX 服务只在 127.0.0.1 上、只被本服务调用：不需要任何认证头。
        return {"X-Read-Podcast-Request-ID": request_id} if request_id else None

    def _transcribe_upload(self, audio_file: str, request_id: str | None = None, language: str | None = None) -> httpx.Response:
        with open(audio_file, "rb") as handle:
            return httpx.post(
                self.api_url,
                headers=self._headers(request_id),
                data={"language": language} if language else None,
                files={"file": (os.path.basename(audio_file), handle, "audio/*")},
                timeout=self.timeout,
            )

    def _progress_url(self, request_id: str) -> str:
        return f"{self.api_url[: -len('/transcribe')]}/progress/{request_id}"

    def _request_with_progress(self, request: Callable[[str | None], httpx.Response], progress_callback: Callable | None) -> httpx.Response:
        if not progress_callback:
            return request(None)
        request_id = str(uuid.uuid4())
        progress_url = self._progress_url(request_id)
        last_snapshot: tuple[int, int, int] | None = None
        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(request, request_id)
                while True:
                    try:
                        return future.result(timeout=1.0)
                    except FuturesTimeoutError:
                        try:
                            response = httpx.get(progress_url, timeout=2.0)
                            if response.status_code != 200:
                                continue
                            payload = response.json()
                            snapshot = (
                                int(payload.get("progress", 0)),
                                int(payload.get("completed_chunks", 0)),
                                int(payload.get("total_chunks", 0)),
                            )
                            if snapshot == last_snapshot:
                                continue
                            last_snapshot = snapshot
                            mlx_pct, completed, total = snapshot
                            stage_pct = 10 + round(mlx_pct * 0.85)
                            message = (
                                f"Whisper 分片 {completed}/{total}（{mlx_pct}%）"
                                if total
                                else "Whisper 已接收音频，正在分片…"
                            )
                            progress_callback("transcribing", stage_pct, message)
                        except Exception:
                            continue
        finally:
            try:
                httpx.delete(progress_url, timeout=2.0)
            except Exception:
                pass

    def transcribe(self, audio_file: str, progress_callback: Callable | None = None, language: str | None = None) -> TranscriptionResult:
        if not os.path.isfile(audio_file):
            raise EngineError("engine_failed", f"音频文件不存在: {os.path.basename(audio_file)}")
        file_size = os.path.getsize(audio_file)
        if progress_callback:
            progress_callback("transcribing", 10, f"上传音频到本机 MLX 引擎 ({file_size // 1024}KB)…")
        try:
            response = self._request_with_progress(
                lambda request_id: self._transcribe_upload(audio_file, request_id, language),
                progress_callback,
            )
            response.raise_for_status()
            result = TranscriptionResult.from_dict(response.json())
        except Exception as exc:
            logger.warning("转录失败: %s", type(exc).__name__)
            raise _classify_http_error(exc) from exc
        if not result.text or not result.text.strip():
            raise EngineError("transcription_empty", "转录结果为空")
        if progress_callback:
            progress_callback("transcribing", 100, f"转录完成 ({len(result.text)} 字符)")
        return result


def get_transcriber() -> Transcriber:
    """按内建策略选择转录引擎（可由 ``READ_PODCAST_TRANSCRIPTION_ENGINE`` 强制）。"""
    engine = resolve_engine()
    if engine == ENGINE_MLX:
        return WhisperApiTranscriber()
    if engine == ENGINE_OPENAI_PROXY:
        return _openai_proxy_transcriber()
    return _faster_whisper_transcriber()


_faster_whisper: Transcriber | None = None
_openai_proxy: Transcriber | None = None


def _faster_whisper_transcriber() -> Transcriber:
    """进程内单例：JobManager 每个任务都会调用 get_transcriber()，模型必须跨任务常驻，
    不能每个任务重新加载一次。"""
    global _faster_whisper
    if _faster_whisper is None:
        # 延迟导入：faster_whisper_engine 反过来依赖本模块的协议类型。
        from core.faster_whisper_engine import FasterWhisperTranscriber

        _faster_whisper = FasterWhisperTranscriber()
    return _faster_whisper


def _openai_proxy_transcriber() -> Transcriber:
    """进程内单例：JobManager 每个任务都会调用 get_transcriber()，复用代理实例。"""
    global _openai_proxy
    if _openai_proxy is None:
        from core.openai_proxy_engine import OpenAIProxyTranscriber

        _openai_proxy = OpenAIProxyTranscriber()
    return _openai_proxy


def engine_name() -> str:
    """/health 等处展示的引擎名（不含机密）。"""
    engine = resolve_engine()
    if engine == ENGINE_MLX:
        return ENGINE_MLX
    if engine == ENGINE_OPENAI_PROXY:
        return ENGINE_OPENAI_PROXY
    return "faster-whisper"
