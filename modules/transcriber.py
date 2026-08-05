"""Whisper HTTP 客户端与统一转录结果。"""
from __future__ import annotations

import logging
import os
import uuid
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


class WhisperApiTranscriber:
    """调用宿主机上的原生 MLX Whisper HTTP 服务。"""

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
            headers["X-Podcast2MD-Request-ID"] = request_id
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
        if cache_path and Path(cache_path).exists():
            logger.info("检测到原始文本缓存，跳过转录。")
            if progress_callback:
                progress_callback("transcribing", 100, "检测到缓存，跳过转录阶段")
            return TranscriptionResult(text=Path(cache_path).read_text(encoding="utf-8"))

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

        if cache_path:
            path = Path(cache_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = path.with_suffix(f"{path.suffix}.part")
            temp_path.write_text(result.text, encoding="utf-8")
            temp_path.replace(path)

        if progress_callback:
            progress_callback("transcribing", 100, f"转录完成 ({len(result.text)} 字符)")
        return result


def _transcription_settings(config: dict | None) -> dict:
    """读取普通配置；转录后端地址只从配置读取，凭据只从环境变量注入。"""
    config = config or {}
    return {
        "api_url": str(config.get("api_url", "")).strip(),
        "timeout": int(config.get("timeout", 1800)),
        "model": config.get("model", "server-managed"),
        "api_token": os.getenv("PODCAST2MD_WHISPER_API_TOKEN", ""),
        "shared_audio_root": config.get("shared_audio_root", ""),
    }


def _resolve_config(config: dict | None) -> dict:
    if config is None:
        from modules.config import settings

        config = settings.TRANSCRIPTION_CONFIG
    return config


def get_transcriber(config: dict | None = None) -> WhisperApiTranscriber:
    s = _transcription_settings(_resolve_config(config))
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


def describe_transcriber(config: dict | None = None) -> dict:
    """返回不含 URL、路径和凭据的公开运行信息。"""
    return {
        "backend": "mlx-api",
        "engine": "mlx-whisper",
        "device": "native-macos",
        "model": _transcription_settings(_resolve_config(config))["model"],
        "self_contained": False,
    }
