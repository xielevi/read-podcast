"""macOS Apple Silicon 原生 MLX Whisper HTTP 服务。"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from modules.config import PROJECT_ROOT, settings


MLX_CONFIG = settings.MLX_CONFIG
MODEL = str(MLX_CONFIG.get("model", "mlx-community/whisper-large-v3-turbo"))
HOST = os.getenv("PODCAST2MD_MLX_HOST", str(MLX_CONFIG.get("host", "127.0.0.1")))
PORT = int(os.getenv("PODCAST2MD_MLX_PORT", str(MLX_CONFIG.get("port", 21567))))
CHUNK_DURATION = max(0, int(MLX_CONFIG.get("chunk_duration", 600)))
CHUNK_WORKERS = max(1, int(MLX_CONFIG.get("chunk_workers", 2)))
MODEL_IDLE_TTL_SECONDS = max(0, int(MLX_CONFIG.get("model_idle_seconds", 300)))
API_TOKEN = os.getenv("PODCAST2MD_WHISPER_API_TOKEN", "")
MAX_UPLOAD_BYTES = max(1, int(MLX_CONFIG.get("max_upload_bytes", 2 * 1024 * 1024 * 1024)))

logger = logging.getLogger(__name__)

_shared_audio_root_value = str(MLX_CONFIG.get("shared_audio_root", "")).strip()
if _shared_audio_root_value:
    _shared_audio_root = Path(_shared_audio_root_value).expanduser()
    SHARED_AUDIO_ROOT = (
        _shared_audio_root
        if _shared_audio_root.is_absolute()
        else PROJECT_ROOT / _shared_audio_root
    ).resolve()
else:
    SHARED_AUDIO_ROOT = None

ALLOWED_AUDIO_SUFFIXES = {
    ".aac",
    ".flac",
    ".m4a",
    ".mp3",
    ".mp4",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
    ".wma",
}

_transcription_lock = asyncio.Lock()
_model_release_task: asyncio.Task | None = None
_request_progress: dict[str, dict[str, Any]] = {}
_request_id_pattern = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


class SharedPathRequest(BaseModel):
    path: str
    model: str | None = None
    language: str | None = None
    prompt: str | None = None
    response_format: str = "json"
    word_timestamps: bool = False
    temperature: float | None = None
    compression_ratio_threshold: float | None = None
    logprob_threshold: float | None = None
    no_speech_threshold: float | None = None


def _release_mlx_model() -> None:
    import mlx.core as mx
    from mlx_whisper.transcribe import ModelHolder

    ModelHolder.model = None
    ModelHolder.model_path = None
    mx.clear_cache()


def _cancel_model_release() -> None:
    global _model_release_task
    if _model_release_task and not _model_release_task.done():
        _model_release_task.cancel()
    _model_release_task = None


async def _release_model_after_idle() -> None:
    global _model_release_task
    try:
        await asyncio.sleep(MODEL_IDLE_TTL_SECONDS)
        async with _transcription_lock:
            await asyncio.to_thread(_release_mlx_model)
    except asyncio.CancelledError:
        raise
    finally:
        if asyncio.current_task() is _model_release_task:
            _model_release_task = None


async def _arm_model_release() -> None:
    global _model_release_task
    _cancel_model_release()
    if MODEL_IDLE_TTL_SECONDS == 0:
        await asyncio.to_thread(_release_mlx_model)
        return
    _model_release_task = asyncio.create_task(_release_model_after_idle())


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        yield
    finally:
        _cancel_model_release()


app = FastAPI(title="Podcast2MD MLX Backend", lifespan=lifespan)


def _authorize(authorization: str | None) -> None:
    if API_TOKEN and authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=403, detail="Invalid API token")


def _model_name(requested: str | None) -> str:
    if not requested or requested == "whisper-1":
        return MODEL
    if requested != MODEL:
        raise HTTPException(status_code=400, detail="requested model is not allowed")
    return MODEL


def _response_format(value: str) -> str:
    if value not in {"json", "verbose_json", "text"}:
        raise HTTPException(
            status_code=400,
            detail="response_format must be json, verbose_json, or text",
        )
    return value


def _transcribe_options(
    *,
    language: str | None = None,
    prompt: str | None = None,
    word_timestamps: bool = False,
    temperature: float | None = None,
    compression_ratio_threshold: float | None = None,
    logprob_threshold: float | None = None,
    no_speech_threshold: float | None = None,
) -> dict[str, Any]:
    options: dict[str, Any] = {
        "language": language,
        "task": "transcribe",
        "initial_prompt": prompt,
        "word_timestamps": word_timestamps,
        "verbose": False,
        "temperature": temperature,
        "compression_ratio_threshold": compression_ratio_threshold,
        "logprob_threshold": logprob_threshold,
        "no_speech_threshold": no_speech_threshold,
    }
    return {key: value for key, value in options.items() if value is not None}


def _chunk_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def _set_request_progress(
    request_id: str | None,
    *,
    progress: int,
    completed_chunks: int = 0,
    total_chunks: int = 0,
    status: str = "running",
) -> None:
    if not request_id:
        return
    _request_progress[request_id] = {
        "status": status,
        "progress": max(0, min(100, int(progress))),
        "completed_chunks": max(0, int(completed_chunks)),
        "total_chunks": max(0, int(total_chunks)),
    }


def _transcribe_sync(
    audio_path: Path,
    model: str,
    options: dict[str, Any],
    progress_callback=None,
) -> dict:
    import mlx_whisper

    if CHUNK_DURATION <= 0:
        if progress_callback:
            progress_callback(0, 1)
        result = mlx_whisper.transcribe(
            str(audio_path),
            path_or_hf_repo=model,
            **options,
        )
        if progress_callback:
            progress_callback(1, 1)
        return result

    chunk_dir = Path(tempfile.mkdtemp(prefix="whisper_mlx_chunks_"))
    try:
        suffix = audio_path.suffix or ".m4a"
        pattern = chunk_dir / f"chunk_%03d{suffix}"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(audio_path),
                "-f",
                "segment",
                "-segment_time",
                str(CHUNK_DURATION),
                "-c",
                "copy",
                str(pattern),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        chunks = sorted(chunk_dir.glob("chunk_*"))
        if not chunks:
            raise RuntimeError("ffmpeg 未生成转录分片")
        if progress_callback:
            progress_callback(0, len(chunks))

        results: list[dict | None] = [None] * len(chunks)
        completed = 0
        with ThreadPoolExecutor(max_workers=CHUNK_WORKERS) as executor:
            futures = {
                executor.submit(
                    mlx_whisper.transcribe,
                    str(chunk),
                    path_or_hf_repo=model,
                    **options,
                ): index
                for index, chunk in enumerate(chunks)
            }
            for future in as_completed(futures):
                results[futures[future]] = future.result()
                completed += 1
                if progress_callback:
                    progress_callback(completed, len(chunks))

        merged_text: list[str] = []
        merged_segments: list[dict] = []
        offset = 0.0
        language = None
        for chunk, result in zip(chunks, results):
            if result is None:
                raise RuntimeError(f"分片没有返回结果: {chunk.name}")
            merged_text.append(result.get("text", "").strip())
            language = language or result.get("language")
            for segment in result.get("segments", []):
                merged_segments.append(
                    {
                        **segment,
                        "start": segment.get("start", 0.0) + offset,
                        "end": segment.get("end", 0.0) + offset,
                    }
                )
            offset += _chunk_duration(chunk)

        return {
            "text": " ".join(text for text in merged_text if text),
            "language": language,
            "segments": merged_segments,
            "duration": offset,
        }
    finally:
        shutil.rmtree(chunk_dir, ignore_errors=True)


async def _transcribe_audio(
    audio_path: Path,
    *,
    model: str = MODEL,
    options: dict[str, Any] | None = None,
    request_id: str | None = None,
) -> dict:
    async with _transcription_lock:
        _cancel_model_release()
        try:
            result = await asyncio.to_thread(
                _transcribe_sync,
                audio_path,
                model,
                options or {"word_timestamps": False, "verbose": False},
                lambda completed, total: _set_request_progress(
                    request_id,
                    progress=round(completed / max(1, total) * 100),
                    completed_chunks=completed,
                    total_chunks=total,
                ),
            )
        finally:
            await _arm_model_release()
    if not isinstance(result, dict) or not result.get("text"):
        raise RuntimeError("MLX Whisper 返回了空结果")
    _set_request_progress(request_id, progress=100, status="done")
    return result


def _request_id(value: str | None) -> str | None:
    candidate = str(value or "").strip()
    return candidate if _request_id_pattern.fullmatch(candidate) else None


def _render_result(result: dict, response_format: str):
    if response_format == "text":
        return PlainTextResponse(result.get("text", ""))
    return _json_safe(result)


def _json_safe(value: Any) -> Any:
    """把 MLX 结果转换为严格 JSON 可序列化的数据。

    某些静音或异常片段会产生 NaN/Infinity 指标。Python 的 JSON 默认可容忍，
    但 Starlette 按标准 JSON 拒绝这些值；指标缺失不应让已经完成的转录整体失败。
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "engine": "mlx-whisper", "model": MODEL, "port": PORT}


@app.get("/progress/{request_id}")
async def transcription_progress(
    request_id: str,
    authorization: str | None = Header(default=None),
) -> dict:
    _authorize(authorization)
    clean_id = _request_id(request_id)
    if not clean_id or clean_id not in _request_progress:
        raise HTTPException(status_code=404, detail="transcription progress not found")
    return dict(_request_progress[clean_id])


@app.delete("/progress/{request_id}")
async def clear_transcription_progress(
    request_id: str,
    authorization: str | None = Header(default=None),
) -> dict:
    _authorize(authorization)
    clean_id = _request_id(request_id)
    if clean_id:
        _request_progress.pop(clean_id, None)
    return {"status": "cleared"}


@app.post("/transcribe")
@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
    model: str | None = Form(default=None),
    language: str | None = Form(default=None),
    prompt: str | None = Form(default=None),
    response_format: str = Form(default="json"),
    word_timestamps: bool = Form(default=False),
    temperature: float | None = Form(default=None),
    compression_ratio_threshold: float | None = Form(default=None),
    logprob_threshold: float | None = Form(default=None),
    no_speech_threshold: float | None = Form(default=None),
    x_podcast2md_request_id: str | None = Header(default=None),
):
    _authorize(authorization)
    response_format = _response_format(response_format)
    request_id = _request_id(x_podcast2md_request_id)
    _set_request_progress(request_id, progress=0)
    suffix = Path(file.filename or "audio").suffix or ".audio"
    temp_path: Path | None = None
    total_bytes = 0
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
            temp_path = Path(handle.name)
            while chunk := await file.read(1024 * 1024):
                total_bytes += len(chunk)
                if total_bytes > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="audio file is too large")
                handle.write(chunk)

        result = await _transcribe_audio(
            temp_path,
            model=_model_name(model),
            options=_transcribe_options(
                language=language,
                prompt=prompt,
                word_timestamps=word_timestamps,
                temperature=temperature,
                compression_ratio_threshold=compression_ratio_threshold,
                logprob_threshold=logprob_threshold,
                no_speech_threshold=no_speech_threshold,
            ),
            request_id=request_id,
        )
        return _render_result(result, response_format)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("MLX transcription failed")
        raise HTTPException(status_code=500, detail="transcription failed") from exc
    finally:
        await file.close()
        if temp_path:
            temp_path.unlink(missing_ok=True)


@app.post("/transcribe-path")
async def transcribe_path(
    body: SharedPathRequest,
    authorization: str | None = Header(default=None),
    x_podcast2md_request_id: str | None = Header(default=None),
):
    _authorize(authorization)
    if SHARED_AUDIO_ROOT is None:
        raise HTTPException(status_code=404, detail="Shared audio path is disabled")
    candidate = Path(body.path)
    if candidate.is_absolute():
        raise HTTPException(status_code=400, detail="path must be relative")
    try:
        resolved = (SHARED_AUDIO_ROOT / candidate).resolve()
        resolved.relative_to(SHARED_AUDIO_ROOT)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=403, detail="audio path is outside the shared root") from exc
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="audio file not found")
    if not resolved.is_file() or resolved.suffix.lower() not in ALLOWED_AUDIO_SUFFIXES:
        raise HTTPException(status_code=400, detail="unsupported audio file")

    response_format = _response_format(body.response_format)
    request_id = _request_id(x_podcast2md_request_id)
    _set_request_progress(request_id, progress=0)
    try:
        result = await _transcribe_audio(
            resolved,
            model=_model_name(body.model),
            options=_transcribe_options(
                language=body.language,
                prompt=body.prompt,
                word_timestamps=body.word_timestamps,
                temperature=body.temperature,
                compression_ratio_threshold=body.compression_ratio_threshold,
                logprob_threshold=body.logprob_threshold,
                no_speech_threshold=body.no_speech_threshold,
            ),
            request_id=request_id,
        )
        return _render_result(result, response_format)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("MLX shared-path transcription failed")
        raise HTTPException(status_code=500, detail="transcription failed") from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
