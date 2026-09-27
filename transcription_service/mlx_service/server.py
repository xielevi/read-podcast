import asyncio
import logging
import shutil
import tempfile
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, Header, UploadFile

from core.config import default_log_dir
from mlx_service.engine import engine

LOG_DIR = default_log_dir()
LOG_DIR.mkdir(parents=True, exist_ok=True)

logger = logging.getLogger("mlx_service")
logger.setLevel(logging.INFO)
if not logger.handlers:
    import sys
    _file_handler = RotatingFileHandler(
        LOG_DIR / "mlx.log",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    _file_handler.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] %(name)s: %(message)s"))
    _console_handler = logging.StreamHandler(sys.stdout)
    _console_handler.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] %(name)s: %(message)s"))
    logger.addHandler(_file_handler)
    logger.addHandler(_console_handler)


@asynccontextmanager
async def lifespan(_: FastAPI):
    watchdog = asyncio.create_task(engine.idle_watchdog_loop())
    try:
        yield
    finally:
        watchdog.cancel()
        try:
            await watchdog
        except asyncio.CancelledError:
            pass
        await engine.unload_model()


app = FastAPI(title="MLX Whisper Service", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "mlx-whisper",
        "model_loaded": engine.is_loaded,
        "model_name": engine.model_name,
        "idle_seconds": round(engine.idle_seconds, 1),
    }


@app.post("/transcribe")
async def transcribe_upload(
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
    x_read_podcast_request_id: str | None = Header(default=None),
) -> dict[str, Any]:
    suffix = Path(file.filename or "audio.mp3").suffix or ".mp3"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = Path(tmp.name)
        shutil.copyfileobj(file.file, tmp)

    try:
        return await engine.transcribe(tmp_path, request_id=x_read_podcast_request_id, language=language)
    finally:
        tmp_path.unlink(missing_ok=True)


@app.get("/progress/{request_id}")
async def get_progress(request_id: str) -> dict[str, Any]:
    return engine.get_progress(request_id)


@app.delete("/progress/{request_id}")
async def delete_progress(request_id: str) -> dict[str, Any]:
    engine.delete_progress(request_id)
    return {"ok": True}
