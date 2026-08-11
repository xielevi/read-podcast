"""转录引擎：统一结果结构 + 可插拔后端。

后端由 ``transcription.backend`` 选择：

- ``mlx-api``（默认）：调用宿主机上的原生 MLX Whisper HTTP 服务，仅 Apple Silicon。
- ``openai-api``：调用任意 **OpenAI 兼容** 的 ``/audio/transcriptions`` 接口
  （OpenAI、Groq、自建 faster-whisper-server 等），与平台无关，可在
  Windows / Linux / Intel Mac 上运行，无需本机 MLX 进程。

设计原则与 refiner 保持一致：后端地址、模型与普通参数只从配置读取，代码不硬编码
任何提供商；鉴权 Key 只从环境变量注入。
"""
from __future__ import annotations

import logging
import os
import uuid
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from pathlib import Path
from typing import Any, Callable

import httpx

logger = logging.getLogger(__name__)


class TranscriptionResult:
    """标准转录结果，兼容 OpenAI Audio API 的 JSON 结构。"""

    def __init__(
        self,
        text: str,
        language: str | None = None,
        segments: list[dict] | None = None,
        duration: float | None = None,
    ):
        self.text = text
        self.language = language
        self.segments = segments or []
        self.duration = duration

    def to_dict(self) -> dict:
        data: dict[str, Any] = {"text": self.text}
        if self.language:
            data["language"] = self.language
        if self.segments:
            data["segments"] = self.segments
        if self.duration is not None:
            data["duration"] = self.duration
        return data

    @classmethod
    def from_dict(cls, data: dict) -> TranscriptionResult:
        return cls(
            text=data.get("text", ""),
            language=data.get("language"),
            segments=data.get("segments"),
            duration=data.get("duration"),
        )


# ── 缓存工具（各后端共用）────────────────────────────────────


def _read_cached_result(
    cache_path: str | None,
    progress_callback: Callable | None,
) -> TranscriptionResult | None:
    """命中原始转录缓存则直接返回，避免重复下载与转录。"""
    if cache_path and Path(cache_path).exists():
        logger.info("检测到原始文本缓存，跳过转录。")
        if progress_callback:
            progress_callback("transcribing", 100, "检测到缓存，跳过转录阶段")
        return TranscriptionResult(text=Path(cache_path).read_text(encoding="utf-8"))
    return None


def _write_cache(cache_path: str | None, text: str) -> None:
    """原子写入原始转录缓存。"""
    if not cache_path:
        return
    path = Path(cache_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(f"{path.suffix}.part")
    temp_path.write_text(text, encoding="utf-8")
    temp_path.replace(path)


# ── 抽象基类 ────────────────────────────────────────────────


class BaseTranscriber(ABC):
    """转录引擎基类。所有后端返回统一的 ``TranscriptionResult``。"""

    @abstractmethod
    def transcribe(
        self,
        audio_file: str,
        cache_path: str | None = None,
        progress_callback: Callable | None = None,
    ) -> TranscriptionResult | None:
        ...


class WhisperApiTranscriber(BaseTranscriber):
    """调用宿主机上的原生 MLX Whisper HTTP 服务（后端 ``mlx-api``）。"""

    def __init__(
        self,
        api_url: str,
        timeout: int = 1800,
        api_token: str = "",
        shared_audio_root: str = "",
    ):
        self.api_url = api_url.rstrip("/")
        if not self.api_url.endswith("/transcribe"):
            self.api_url += "/transcribe"
        self.timeout = timeout
        self.api_token = api_token
        self.shared_audio_root = (
            Path(shared_audio_root).expanduser().resolve() if shared_audio_root else None
        )

    @property
    def path_api_url(self) -> str:
        if self.api_url.endswith("/transcribe"):
            return self.api_url[: -len("/transcribe")] + "/transcribe-path"
        return self.api_url.rstrip("/") + "/transcribe-path"

    def _shared_relative_path(self, audio_file: str) -> str | None:
        if not self.shared_audio_root:
            return None
        try:
            return str(Path(audio_file).resolve().relative_to(self.shared_audio_root))
        except (OSError, ValueError):
            return None

    def _headers(self, request_id: str | None = None) -> dict | None:
        headers = {}
        if self.api_token:
            headers["Authorization"] = f"Bearer {self.api_token}"
        if request_id:
            headers["X-Read-Podcast-Request-ID"] = request_id
        return headers or None

    def _transcribe_shared_path(
        self,
        relative_path: str,
        request_id: str | None = None,
    ) -> httpx.Response:
        return httpx.post(
            self.path_api_url,
            headers=self._headers(request_id),
            json={"path": relative_path},
            timeout=self.timeout,
        )

    def _transcribe_upload(
        self,
        audio_file: str,
        request_id: str | None = None,
    ) -> httpx.Response:
        with open(audio_file, "rb") as handle:
            return httpx.post(
                self.api_url,
                headers=self._headers(request_id),
                files={"file": (os.path.basename(audio_file), handle, "audio/*")},
                timeout=self.timeout,
            )

    def _progress_url(self, request_id: str) -> str:
        base_url = self.api_url[: -len("/transcribe")]
        return f"{base_url}/progress/{request_id}"

    def _request_with_progress(
        self,
        request,
        progress_callback: Callable | None,
    ) -> httpx.Response:
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
                            response = httpx.get(
                                progress_url,
                                headers=self._headers(),
                                timeout=2.0,
                            )
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
                            # 旧版或暂不可用的进度接口不影响主转录请求。
                            continue
        finally:
            try:
                httpx.delete(progress_url, headers=self._headers(), timeout=2.0)
            except Exception:
                pass

    def transcribe(
        self,
        audio_file: str,
        cache_path: str | None = None,
        progress_callback: Callable | None = None,
    ) -> TranscriptionResult | None:
        cached = _read_cached_result(cache_path, progress_callback)
        if cached is not None:
            return cached

        if not os.path.isfile(audio_file):
            logger.error("音频文件不存在: %s", audio_file)
            return None

        file_size = os.path.getsize(audio_file)
        relative_path = self._shared_relative_path(audio_file)
        if progress_callback:
            mode = "提交共享音频" if relative_path else "上传音频"
            progress_callback("transcribing", 10, f"{mode} ({file_size // 1024}KB)…")

        try:
            response = self._request_with_progress(
                lambda request_id: (
                    self._transcribe_shared_path(relative_path, request_id)
                    if relative_path
                    else self._transcribe_upload(audio_file, request_id)
                ),
                progress_callback,
            )
            if relative_path and response.status_code in {403, 404, 405, 501}:
                logger.warning("Whisper 不支持共享路径接口，回退 multipart 上传")
                if progress_callback:
                    progress_callback("transcribing", 10, "共享路径不可用，回退音频上传…")
                response = self._request_with_progress(
                    lambda request_id: self._transcribe_upload(audio_file, request_id),
                    progress_callback,
                )
            response.raise_for_status()
            result = TranscriptionResult.from_dict(response.json())
        except Exception as exc:
            logger.exception("转录失败: %s", exc)
            return None

        if not result.text:
            logger.error("转录结果为空。")
            return None

        _write_cache(cache_path, result.text)

        if progress_callback:
            progress_callback("transcribing", 100, f"转录完成 ({len(result.text)} 字符)")
        return result


class OpenAITranscriber(BaseTranscriber):
    """调用任意 OpenAI 兼容的 ``/audio/transcriptions`` 接口（后端 ``openai-api``）。

    与平台无关：只要有一个可访问的 OpenAI 兼容转录服务即可，无需本机 MLX 进程。
    常见选择：

    - Groq（``https://api.groq.com/openai/v1``，模型 ``whisper-large-v3``）
    - OpenAI（``https://api.openai.com/v1``，模型 ``whisper-1``；单文件 ≤25MB）
    - 自建 faster-whisper-server（``http://127.0.0.1:8000/v1``，无云端体积限制）

    地址与模型来自配置，Key 只从环境变量注入。
    """

    def __init__(
        self,
        api_base: str,
        model: str,
        api_key: str = "",
        timeout: int = 1800,
        language: str = "",
        max_upload_bytes: int = 0,
    ):
        self.api_base = api_base.strip().rstrip("/")
        if not self.api_base:
            raise ValueError(
                "openai-api 转录后端缺少 api_base：请在 config.yaml 的 "
                "transcription.openai.api_base 填写 OpenAI 兼容服务地址。"
            )
        self.model = str(model).strip()
        if not self.model:
            raise ValueError(
                "openai-api 转录后端缺少 model：请在 config.yaml 的 "
                "transcription.openai.model 填写转录模型名（如 whisper-1）。"
            )
        self.api_key = api_key
        self.timeout = timeout
        self.language = str(language).strip()
        self.max_upload_bytes = max(0, int(max_upload_bytes))
        self._endpoint = f"{self.api_base}/audio/transcriptions"
        if not self.api_key:
            logger.warning(
                "未设置转录 API Key。请在 .env 中设置 READ_PODCAST_TRANSCRIPTION_API_KEY"
            )

    def _headers(self) -> dict | None:
        if self.api_key:
            return {"Authorization": f"Bearer {self.api_key}"}
        return None

    def transcribe(
        self,
        audio_file: str,
        cache_path: str | None = None,
        progress_callback: Callable | None = None,
    ) -> TranscriptionResult | None:
        cached = _read_cached_result(cache_path, progress_callback)
        if cached is not None:
            return cached

        if not os.path.isfile(audio_file):
            logger.error("音频文件不存在: %s", audio_file)
            return None

        file_size = os.path.getsize(audio_file)
        if self.max_upload_bytes and file_size > self.max_upload_bytes:
            logger.error(
                "音频 %.1fMB 超过 openai-api 后端上限 %.1fMB；"
                "云端接口通常限制 25MB，超大文件建议改用自建 faster-whisper-server。",
                file_size / 1024 / 1024,
                self.max_upload_bytes / 1024 / 1024,
            )
            return None

        if progress_callback:
            progress_callback("transcribing", 15, f"上传音频到转录服务 ({file_size // 1024}KB)…")

        data = {"model": self.model, "response_format": "json"}
        if self.language:
            data["language"] = self.language

        try:
            with open(audio_file, "rb") as handle:
                response = httpx.post(
                    self._endpoint,
                    headers=self._headers(),
                    data=data,
                    files={"file": (os.path.basename(audio_file), handle, "audio/*")},
                    timeout=self.timeout,
                )
            response.raise_for_status()
            content_type = response.headers.get("content-type", "")
            if "application/json" in content_type:
                result = TranscriptionResult.from_dict(response.json())
            else:
                # response_format=text 或非 JSON：直接取纯文本正文。
                result = TranscriptionResult(text=response.text.strip())
        except httpx.HTTPStatusError as exc:
            logger.error("转录服务返回异常状态码 %s，响应正文未写入日志", exc.response.status_code)
            return None
        except Exception as exc:
            logger.exception("转录失败: %s", exc)
            return None

        if not result.text:
            logger.error("转录结果为空。")
            return None

        _write_cache(cache_path, result.text)

        if progress_callback:
            progress_callback("transcribing", 100, f"转录完成 ({len(result.text)} 字符)")
        return result


# ── 配置读取与工厂 ──────────────────────────────────────────


def _env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return default


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _transcription_settings(config: dict | None) -> dict:
    """读取普通配置；后端地址只从配置读取，凭据只从环境变量注入。"""
    config = config or {}
    openai_cfg = dict(config.get("openai", {}) or {})
    return {
        "backend": str(config.get("backend", "mlx-api")).strip() or "mlx-api",
        # mlx-api 后端
        "api_url": str(config.get("api_url", "")).strip(),
        "timeout": int(config.get("timeout", 1800)),
        "model": config.get("model", "server-managed"),
        "api_token": _env(
            "READ_PODCAST_WHISPER_API_TOKEN",
            "PODCAST2MD_WHISPER_API_TOKEN",
        ),
        "shared_audio_root": config.get("shared_audio_root", ""),
        # openai-api 后端
        "openai_api_base": str(openai_cfg.get("api_base", "")).strip(),
        "openai_model": str(openai_cfg.get("model", "")).strip(),
        "openai_language": str(openai_cfg.get("language", "")).strip(),
        "openai_timeout": int(openai_cfg.get("timeout", config.get("timeout", 1800))),
        "openai_max_upload_bytes": int(openai_cfg.get("max_upload_bytes", 0)),
        "openai_self_contained": _as_bool(openai_cfg.get("self_contained", False)),
        "openai_api_key": _env(
            "READ_PODCAST_TRANSCRIPTION_API_KEY",
            "PODCAST2MD_TRANSCRIPTION_API_KEY",
        ),
    }


def _resolve_config(config: dict | None) -> dict:
    if config is None:
        from modules.config import settings

        config = settings.TRANSCRIPTION_CONFIG
    return config


def get_transcriber(config: dict | None = None) -> BaseTranscriber:
    s = _transcription_settings(_resolve_config(config))
    backend = s["backend"]

    if backend == "openai-api":
        return OpenAITranscriber(
            api_base=s["openai_api_base"],
            model=s["openai_model"],
            api_key=s["openai_api_key"],
            timeout=s["openai_timeout"],
            language=s["openai_language"],
            max_upload_bytes=s["openai_max_upload_bytes"],
        )

    if backend == "mlx-api":
        if not s["api_url"]:
            raise ValueError(
                "未配置转录后端：请在 config.yaml 的 transcription 段填写 api_url"
                "（见 config.default.yaml；一键脚本 start.sh 会自动写入本机默认地址）。"
            )
        return WhisperApiTranscriber(
            api_url=s["api_url"],
            timeout=s["timeout"],
            api_token=s["api_token"],
            shared_audio_root=s["shared_audio_root"],
        )

    raise ValueError(
        f"未知转录后端 '{backend}'：请将 transcription.backend 设为 'mlx-api' 或 'openai-api'。"
    )


def describe_transcriber(config: dict | None = None) -> dict:
    """返回不含 URL、路径和凭据的公开运行信息。"""
    s = _transcription_settings(_resolve_config(config))
    backend = s["backend"]
    if backend == "openai-api":
        self_contained = s["openai_self_contained"]
        return {
            "backend": "openai-api",
            "engine": "faster-whisper" if self_contained else "openai-compatible",
            "device": "container-cpu" if self_contained else "remote-or-self-hosted",
            "model": s["openai_model"] or "unset",
            "self_contained": self_contained,
        }
    return {
        "backend": "mlx-api",
        "engine": "mlx-whisper",
        "device": "native-macos",
        "model": s["model"],
        "self_contained": False,
    }
