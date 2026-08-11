"""OpenAI-compatible CPU transcription service backed by Faster-Whisper.

This service is intentionally separate from the Read Podcast web process. It is
started only by ``docker-compose.self-contained.yml`` and keeps the default
Apple Silicon + MLX path unchanged.
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse


logger = logging.getLogger(__name__)


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


MODEL_ID = os.getenv("READ_PODCAST_FASTER_WHISPER_MODEL", "small").strip() or "small"
DEVICE = os.getenv("READ_PODCAST_FASTER_WHISPER_DEVICE", "cpu").strip() or "cpu"
COMPUTE_TYPE = (
    os.getenv("READ_PODCAST_FASTER_WHISPER_COMPUTE_TYPE", "int8").strip() or "int8"
)
CPU_THREADS = max(0, int(os.getenv("READ_PODCAST_FASTER_WHISPER_CPU_THREADS", "0")))
BEAM_SIZE = max(1, int(os.getenv("READ_PODCAST_FASTER_WHISPER_BEAM_SIZE", "5")))
VAD_FILTER = _env_bool("READ_PODCAST_FASTER_WHISPER_VAD_FILTER", True)
MAX_UPLOAD_BYTES = max(
    1,
    int(
        os.getenv(
            "READ_PODCAST_FASTER_WHISPER_MAX_UPLOAD_BYTES",
            str(2 * 1024 * 1024 * 1024),
        )
    ),
)
API_TOKEN = os.getenv("READ_PODCAST_FASTER_WHISPER_API_TOKEN", "")

_model: Any | None = None
_model_init_lock = threading.Lock()
_transcription_lock = asyncio.Lock()

app = FastAPI(title="Read Podcast Built-in Transcription", docs_url=None, redoc_url=None)


def _authorize(authorization: str | None) -> None:
    if not API_TOKEN:
        return
    expected = f"Bearer {API_TOKEN}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=403, detail="Invalid API token")


def _load_model():
    global _model
    if _model is not None:
        return _model
    with _model_init_lock:
        if _model is None:
            from faster_whisper import WhisperModel

            kwargs: dict[str, Any] = {
                "device": DEVICE,
                "compute_type": COMPUTE_TYPE,
            }
            if CPU_THREADS:
                kwargs["cpu_threads"] = CPU_THREADS
            logger.info("Loading Faster-Whisper model %s on %s", MODEL_ID, DEVICE)
            _model = WhisperModel(MODEL_ID, **kwargs)
    return _model


def _transcribe_sync(
    audio_path: Path,
    *,
    language: str,
    prompt: str,
) -> dict[str, Any]:
    model = _load_model()
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=language or None,
        initial_prompt=prompt or None,
        beam_size=BEAM_SIZE,
        vad_filter=VAD_FILTER,
    )
    segments: list[dict[str, Any]] = []
    text_parts: list[str] = []
    for index, segment in enumerate(segments_iter):
        raw_text = str(segment.text or "")
        text = raw_text.strip()
        if raw_text:
            text_parts.append(raw_text)
        segments.append(
            {
                "id": index,
                "start": float(segment.start),
                "end": float(segment.end),
                "text": text,
            }
        )
    return {
        "text": "".join(text_parts).strip(),
        "language": str(getattr(info, "language", "") or ""),
        "duration": float(getattr(info, "duration", 0.0) or 0.0),
        "segments": segments,
    }


async def _save_upload(upload: UploadFile) -> Path:
    suffix = Path(upload.filename or "audio.bin").suffix[:16] or ".bin"
    handle = tempfile.NamedTemporaryFile(prefix="read_podcast_", suffix=suffix, delete=False)
    path = Path(handle.name)
    total = 0
    try:
        with handle:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Audio file exceeds upload limit")
                handle.write(chunk)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()
    return path


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "healthy",
        "service": "read-podcast-transcription",
        "engine": "faster-whisper",
        "model": MODEL_ID,
        "device": DEVICE,
        "model_loaded": _model is not None,
    }


@app.get("/v1/models")
async def models(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _authorize(authorization)
    return {"object": "list", "data": [{"id": MODEL_ID, "object": "model"}]}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form(default="whisper-1"),
    language: str = Form(default=""),
    prompt: str = Form(default=""),
    response_format: str = Form(default="json"),
    authorization: str | None = Header(default=None),
):
    _authorize(authorization)
    requested_model = model.strip()
    if requested_model not in {"", "whisper-1", MODEL_ID}:
        raise HTTPException(status_code=400, detail="Requested model is not available")
    if response_format not in {"json", "verbose_json", "text"}:
        raise HTTPException(status_code=400, detail="Unsupported response_format")

    audio_path = await _save_upload(file)
    try:
        async with _transcription_lock:
            try:
                result = await asyncio.to_thread(
                    _transcribe_sync,
                    audio_path,
                    language=language.strip(),
                    prompt=prompt.strip(),
                )
            except Exception as exc:
                logger.exception("Faster-Whisper transcription failed")
                raise HTTPException(
                    status_code=503,
                    detail="Transcription engine failed; check service logs",
                ) from exc
        if not result["text"]:
            raise HTTPException(status_code=422, detail="Transcription result is empty")
        if response_format == "text":
            return PlainTextResponse(result["text"])
        if response_format == "json":
            return JSONResponse({"text": result["text"]})
        return JSONResponse(result)
    finally:
        audio_path.unlink(missing_ok=True)
