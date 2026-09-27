"""Read Podcast Transcription Service —— 一个薄的、可替换的转录计算节点。

Cloudflare 拥有整条业务任务生命周期；本服务只是它调用的外部计算能力：

    Cloudflare ──POST /v1/transcriptions──▶  取音频 → 转录引擎 → raw transcript
               ◀──GET  /v1/transcriptions/{id}（长轮询）──

协议（详见 ``jobs.py``）是**异步任务模型**：Cloudflare 的出站 HTTP 经反向代理 / Tunnel 时有
数分钟量级的读超时，而真实播客的转录可达数小时，长连接同步请求不可靠。因此提交只返回 202 +
``provider_request_id``，之后由 Cloudflare 的 durable Workflow 自行轮询结果：

    GET /health                                  唯一的健康探针（本机 curl / Cloudflare 经 Access 探测）
    POST /v1/transcriptions                      提交（以 request_id 幂等）
    GET /v1/transcriptions/{id}?wait=N           状态 / 进度 / **结果元数据**
    GET /v1/transcriptions/{id}/result           原始转录正文（text/plain，只取一次）
    DELETE /v1/transcriptions/{id}               尽力取消并释放资源

远程认证由 **Cloudflare Access** 承担（Worker 携带 service credential，经 Tunnel 到本服务）；
本服务不持有任何 application token。它也不做业务判断：任务状态机、attempt 判定、是否重试、
取消的业务结论、raw 持久化、精修与成稿都属于 Cloudflare。它**不主动联系 Cloudflare**：没有
回调、没有对账、没有任何 Cloudflare 凭据——因此把它换到 Windows / Linux / NAS / 云 GPU 只需
部署一个满足同一 HTTP contract 的服务并修改 Cloudflare 侧的 endpoint。

同机部署的 MLX Whisper HTTP 服务（``mlx_service``）是 Apple Silicon 上的转录引擎，地址是
内建默认值（``core.config.MLX_ENDPOINT``），与本服务是两个独立进程；其余平台默认使用
进程内 Faster-Whisper 引擎（``core.faster_whisper_engine``），选择策略见
``core.config.resolve_engine``。
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from typing import Any, Optional

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from core.config import DATA_DIR, default_log_dir
from core.transcriber import engine_name
from jobs import ApiError, JobManager

PROTOCOL_VERSION = 1
MAX_WAIT_SECONDS = 50  # 低于常见反向代理的 100s 空闲超时

logger = logging.getLogger("transcription_service")


def _configure_logging() -> None:
    if logger.handlers:
        return
    logger.setLevel(logging.INFO)
    log_dir = default_log_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    formatter = logging.Formatter("[%(asctime)s] [%(levelname)s] %(name)s: %(message)s")
    file_handler = RotatingFileHandler(log_dir / "transcription.log", maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8")
    file_handler.setFormatter(formatter)
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)


class Source(BaseModel):
    type: str
    url: str = Field(min_length=1, max_length=4096)
    # 调用方给定的体积上限（例如 Cloudflare 的自定义上传硬上限）；与服务自身上限取较小者。
    max_bytes: Optional[int] = Field(default=None, ge=1)


class Options(BaseModel):
    language: Optional[str] = Field(default=None, max_length=32)


class TranscriptionRequest(BaseModel):
    request_id: str
    source: Source
    options: Options = Field(default_factory=Options)


def create_app(manager: Optional[JobManager] = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        _configure_logging()
        jobs = manager or JobManager(DATA_DIR)
        jobs.start()
        app.state.jobs = jobs
        try:
            yield
        finally:
            await jobs.stop()

    app = FastAPI(title="Read Podcast Transcription Service", docs_url=None, redoc_url=None, lifespan=lifespan)

    @app.exception_handler(ApiError)
    async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
        headers = {"Retry-After": "30"} if exc.status == 429 else None
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status, headers=headers)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        """唯一的健康探针：不含机密。本机 curl 验证进程与引擎配置；
        Cloudflare 经 Access + Tunnel 打同一个端点，同时验证 Access 凭据、Tunnel 与本服务。"""
        jobs: JobManager = app.state.jobs
        return {
            "status": "ok",
            "service": "transcription-service",
            "protocol": PROTOCOL_VERSION,
            "engine": engine_name(),
            "active_requests": jobs.active_count,
        }

    @app.post("/v1/transcriptions")
    async def submit(body: TranscriptionRequest) -> JSONResponse:
        if body.source.type != "url":
            raise ApiError(400, "unsupported_source", f"source.type '{body.source.type}' is not supported (only 'url')")
        jobs: JobManager = app.state.jobs
        job, created = jobs.submit(
            body.request_id,
            body.source.url,
            max_bytes=body.source.max_bytes,
            language=(body.options.language or None),
        )
        return JSONResponse(job.snapshot(), status_code=202 if created else 200)

    @app.get("/v1/transcriptions/{provider_request_id}")
    async def status(
        provider_request_id: str,
        wait: int = Query(default=0, ge=0),
    ) -> dict[str, Any]:
        jobs: JobManager = app.state.jobs
        job = jobs.get(provider_request_id)
        await jobs.wait_for_change(job, min(wait, MAX_WAIT_SECONDS))
        return job.snapshot()

    @app.get("/v1/transcriptions/{provider_request_id}/result")
    async def result(provider_request_id: str) -> PlainTextResponse:
        """原始转录正文（text/plain）。状态端点只给元数据，正文在这里单独取一次。

        这不是新的 provider 侧业务状态：正文仍然只属于这一次计算请求，在 ``result_ttl_seconds``
        后被回收；``DELETE`` 依然会连同结果一起释放。
        """
        jobs: JobManager = app.state.jobs
        job = jobs.get(provider_request_id)
        text = job.result_text()
        if text is None:
            raise ApiError(409, "result_not_ready", f"request is in state '{job.state}' and has no result yet")
        return PlainTextResponse(text, media_type="text/plain; charset=utf-8")

    @app.delete("/v1/transcriptions/{provider_request_id}")
    async def cancel(provider_request_id: str) -> dict[str, Any]:
        jobs: JobManager = app.state.jobs
        job = jobs.cancel(provider_request_id)
        return {"provider_request_id": provider_request_id, "status": job.state}

    return app


app = create_app()
