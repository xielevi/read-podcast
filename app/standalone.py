"""Podcast2MD 独立部署入口。"""
from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import os
import secrets
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response

from app.database import close_db, init_db, reset_stale_tasks
from app.router import router
from modules.audio_cleanup import cleanup_expired_audio
from modules.config import settings

P2M_ROOT = Path(__file__).parent.parent.absolute()
FRONTEND_FILE = P2M_ROOT / "app" / "static" / "index.html"
FRONTEND_CSS_FILE = P2M_ROOT / "app" / "static" / "app.css"
FRONTEND_JS_FILE = P2M_ROOT / "app" / "static" / "app.js"
AUDIO_RETENTION_DAYS = int(settings.RUNTIME_CONFIG.get("audio_retention_days", 7))
CLEANUP_INTERVAL_SECONDS = max(
    60,
    int(settings.RUNTIME_CONFIG.get("cleanup_interval_seconds", 24 * 60 * 60)),
)
HEALTH_PATH = "/api/podcast2md/health"

logger = logging.getLogger(__name__)


def _normalize_base_path(value: str | None) -> str:
    path = (value or "").strip()
    if not path or path == "/":
        return ""
    return "/" + path.strip("/")


def _configured_base_path() -> str:
    return _normalize_base_path(settings.WEB_CONFIG.get("base_path"))


def _basic_auth_credentials() -> tuple[str, str] | None:
    username = os.getenv("PODCAST2MD_BASIC_AUTH_USERNAME", "").strip()
    password = os.getenv("PODCAST2MD_BASIC_AUTH_PASSWORD", "")
    if bool(username) != bool(password):
        raise RuntimeError(
            "PODCAST2MD_BASIC_AUTH_USERNAME and PODCAST2MD_BASIC_AUTH_PASSWORD "
            "must be configured together"
        )
    if not username:
        return None
    return username, password


def _valid_basic_auth(request: Request, expected: tuple[str, str]) -> bool:
    authorization = request.headers.get("Authorization", "")
    try:
        scheme, encoded = authorization.split(" ", 1)
        if scheme.lower() != "basic":
            return False
        decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
        username, separator, password = decoded.partition(":")
        if not separator:
            return False
    except (ValueError, UnicodeDecodeError, binascii.Error):
        return False

    expected_username, expected_password = expected
    username_matches = secrets.compare_digest(username.encode(), expected_username.encode())
    password_matches = secrets.compare_digest(password.encode(), expected_password.encode())
    return username_matches and password_matches


def _basic_auth_challenge() -> Response:
    return Response(
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="Podcast2MD", charset="UTF-8"'},
    )


async def _cleanup_once():
    return await asyncio.to_thread(
        cleanup_expired_audio,
        P2M_ROOT,
        P2M_ROOT / "workspace" / "uploads",
        settings.DOWNLOAD_DIR,
        AUDIO_RETENTION_DAYS,
    )


async def _cleanup_loop() -> None:
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        try:
            summary = await _cleanup_once()
            logger.info(
                "定时音频清理: deleted=%s freed=%s",
                summary["deleted_count"],
                summary["freed_bytes"],
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("定时音频清理失败")


@asynccontextmanager
async def lifespan(_: FastAPI):
    _basic_auth_credentials()
    await init_db()
    stale = await reset_stale_tasks()
    if stale:
        logger.info("启动清理: 将 %s 个残留任务标记为 failed", stale)
    await _cleanup_once()
    cleanup_task = asyncio.create_task(_cleanup_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task
        await close_db()


app = FastAPI(title="Podcast2MD", lifespan=lifespan)

# 配置 GZip 中间件，大幅压缩静态文件与大 JSON 传输体积
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def web_access_middleware(request: Request, call_next):
    """兼容保留或剥离 URL 前缀的反向代理，并提供可选 Basic Auth。"""
    base_path = _configured_base_path()
    request_path = request.scope.get("path", "/")
    if base_path and (request_path == base_path or request_path.startswith(f"{base_path}/")):
        stripped_path = request_path[len(base_path) :] or "/"
        request.scope["root_path"] = base_path
        request.scope["path"] = stripped_path
        request.scope["raw_path"] = stripped_path.encode("utf-8")

    credentials = _basic_auth_credentials()
    if credentials and request.scope.get("path") != HEALTH_PATH:
        if not _valid_basic_auth(request, credentials):
            return _basic_auth_challenge()

    return await call_next(request)

app.include_router(router)


@app.get("/")
async def workspace():
    if FRONTEND_FILE.exists():
        return FileResponse(FRONTEND_FILE)
    raise HTTPException(status_code=404, detail="podcast2md workspace page not found")


@app.get("/app.css")
async def frontend_css():
    if FRONTEND_CSS_FILE.exists():
        return FileResponse(FRONTEND_CSS_FILE, media_type="text/css")
    raise HTTPException(status_code=404, detail="podcast2md stylesheet not found")


@app.get("/app.js")
async def frontend_js():
    if FRONTEND_JS_FILE.exists():
        return FileResponse(FRONTEND_JS_FILE, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="podcast2md script not found")
