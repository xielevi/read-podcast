"""Transcription request 的运行态（ephemeral compute state）。

这里只有「一次外部计算请求」的生命周期：

    submit(request_id, source) → queued → fetching → preparing → transcribing → completed | failed | cancelled

它**不是**业务状态机：谁的任务、第几次 attempt、要不要重试、是否已被取消、raw 是否已持久化、
后续精修与成稿，全部属于 Cloudflare。本模块对这些一无所知——``request_id`` 只是 Cloudflare 给的
幂等键（同一个 request_id 重复提交不会重复计算）；``provider_request_id`` 是本服务分配的
不透明句柄，供 Cloudflare 轮询 / 取消 / 取回结果。

进程重启会丢失排队与执行中的请求（临时文件与运行态一并作废）——这是设计内的：Cloudflare 轮询到
「未知请求」（404）后自行决定是否重新提交。已完成的结果会落盘并保留 ``result_ttl_seconds``，
使 Cloudflare 短暂不可用或稍后取回时不必重新转录。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from core.config import DOWNLOAD_CONCURRENCY, MAX_ACTIVE_REQUESTS, RESULT_TTL_SECONDS
from core.downloader import Downloader, SourceError
from core.transcriber import EngineError, Transcriber, get_transcriber

logger = logging.getLogger("transcription_service.jobs")

REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

QUEUED = "queued"
RUNNING = "running"
COMPLETED = "completed"
FAILED = "failed"
CANCELLED = "cancelled"
TERMINAL_STATES = frozenset({COMPLETED, FAILED, CANCELLED})

# progress.phase：queued → fetching → preparing（等待引擎槽位 / 校验）→ transcribing。
PHASE_QUEUED = "queued"
PHASE_FETCHING = "fetching"
PHASE_PREPARING = "preparing"
PHASE_TRANSCRIBING = "transcribing"


class ApiError(Exception):
    """带 HTTP 状态与稳定 code 的请求级错误（由 HTTP 层统一渲染）。"""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


@dataclass
class Job:
    request_id: str
    provider_request_id: str
    source_url: str
    max_bytes: Optional[int] = None
    language: Optional[str] = None
    state: str = QUEUED
    phase: str = PHASE_QUEUED
    percent: int = 0
    message: str = ""
    result: Optional[dict[str, Any]] = None
    error: Optional[dict[str, str]] = None
    cancel_requested: bool = False
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    version: int = 0
    _event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    _task: Optional["asyncio.Task[None]"] = field(default=None, repr=False)

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    def result_text(self) -> Optional[str]:
        """已完成结果的正文；未完成 / 没有正文时返回 None。"""
        if self.state != COMPLETED or self.result is None:
            return None
        text = self.result.get("text")
        return text if isinstance(text, str) else None

    def snapshot(self) -> dict[str, Any]:
        """状态快照：**只有元数据，没有正文**。

        正文单独由 ``GET /v1/transcriptions/{id}/result`` 提供。轮询一次 3 小时的任务会跑上百次，
        把最多 8 MiB 的 raw transcript 塞进每次状态响应纯属浪费（调用方也会在「看到 completed」和
        「取回正文」时各下载解析一遍）。
        """
        body: dict[str, Any] = {
            "request_id": self.request_id,
            "provider_request_id": self.provider_request_id,
            "status": self.state,
            "progress": {"phase": self.phase, "percent": self.percent, "message": self.message},
        }
        if self.state == COMPLETED and self.result is not None:
            body["result"] = {
                "language": str(self.result.get("language") or ""),
                "duration": float(self.result.get("duration") or 0.0),
            }
        if self.state == FAILED and self.error is not None:
            body["error"] = self.error
        return body


class JobManager:
    def __init__(
        self,
        data_dir: Path,
        *,
        transcriber_factory: Callable[[], Transcriber] = get_transcriber,
        downloader_factory: Callable[[Path], Downloader] = Downloader,
    ) -> None:
        self.data_dir = Path(data_dir)
        self._requests_dir = self.data_dir / "requests"
        self._results_dir = self.data_dir / "results"
        self._transcriber_factory = transcriber_factory
        self._downloader_factory = downloader_factory
        self._by_provider_id: dict[str, Job] = {}
        self._by_request_id: dict[str, Job] = {}
        self._download_sem = asyncio.Semaphore(DOWNLOAD_CONCURRENCY)
        self._engine_lock = asyncio.Lock()
        self._sweeper: Optional["asyncio.Task[None]"] = None
        self.max_active = max(1, MAX_ACTIVE_REQUESTS)
        self.result_ttl = max(60, RESULT_TTL_SECONDS)

    # ── 生命周期 ──

    def start(self) -> None:
        """启动：清掉上次进程遗留的临时音频（其请求已随进程消亡），恢复未过期的已完成结果。"""
        shutil.rmtree(self._requests_dir, ignore_errors=True)
        self._requests_dir.mkdir(parents=True, exist_ok=True)
        self._results_dir.mkdir(parents=True, exist_ok=True)
        self._load_persisted_results()
        self._sweeper = asyncio.get_running_loop().create_task(self._sweep_loop())

    async def stop(self) -> None:
        if self._sweeper:
            self._sweeper.cancel()
            try:
                await self._sweeper
            except asyncio.CancelledError:
                pass
        tasks = [job._task for job in self._by_provider_id.values() if job._task and not job._task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    @property
    def active_count(self) -> int:
        return sum(1 for job in self._by_provider_id.values() if not job.terminal)

    # ── 请求入口 ──

    def submit(
        self,
        request_id: str,
        source_url: str,
        *,
        max_bytes: Optional[int] = None,
        language: Optional[str] = None,
    ) -> tuple[Job, bool]:
        """幂等提交。返回 (job, created)：同一 request_id 已有进行中 / 已完成的请求则原样返回。"""
        if not REQUEST_ID_PATTERN.match(request_id):
            raise ApiError(400, "invalid_request", "request_id must match [A-Za-z0-9._:-]{1,128}")
        existing = self._by_request_id.get(request_id)
        if existing is not None:
            if existing.source_url != source_url:
                raise ApiError(409, "request_conflict", "request_id already used with a different source")
            # 失败 / 已取消的请求允许以同一 request_id 重新提交（新的计算）；其余原样返回（幂等）。
            if existing.state in (QUEUED, RUNNING, COMPLETED):
                return existing, False
        if self.active_count >= self.max_active:
            raise ApiError(429, "busy", "too many active transcription requests")

        job = Job(
            request_id=request_id,
            provider_request_id=f"tsr_{uuid.uuid4().hex}",
            source_url=source_url,
            max_bytes=max_bytes,
            language=language,
        )
        self._by_provider_id[job.provider_request_id] = job
        self._by_request_id[request_id] = job
        job._task = asyncio.get_running_loop().create_task(self._run(job))
        return job, True

    def get(self, provider_request_id: str) -> Job:
        job = self._by_provider_id.get(provider_request_id)
        if job is None:
            raise ApiError(404, "unknown_request", "no such transcription request")
        return job

    async def wait_for_change(self, job: Job, timeout: float) -> None:
        """长轮询：直到该请求发生任何可见变化（进度 / 状态）或超时。终态直接返回。"""
        if job.terminal or timeout <= 0:
            return
        event = job._event
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass

    def cancel(self, provider_request_id: str) -> Job:
        """尽力取消并释放资源；对终态请求等价于「释放结果」。幂等。"""
        job = self.get(provider_request_id)
        if not job.terminal:
            job.cancel_requested = True
            if job._task and not job._task.done() and job.state == QUEUED:
                job._task.cancel()
            self._update(job, state=CANCELLED, message="cancelled")
            self._cleanup_files(job)
        else:
            self._forget(job)
        return job

    # ── 执行 ──

    def _update(self, job: Job, **changes: Any) -> None:
        for key, value in changes.items():
            setattr(job, key, value)
        job.updated_at = time.time()
        job.version += 1
        previous, job._event = job._event, asyncio.Event()
        previous.set()

    def _progress(self, job: Job, phase: str, percent: int, message: str) -> None:
        if job.terminal:
            return
        self._update(job, phase=phase, percent=max(0, min(100, int(percent))), message=message[:300])

    def _workdir(self, job: Job) -> Path:
        return self._requests_dir / job.provider_request_id

    def _cleanup_files(self, job: Job) -> None:
        shutil.rmtree(self._workdir(job), ignore_errors=True)

    def _fail(self, job: Job, code: str, message: str) -> None:
        if job.terminal:
            return
        logger.warning("request %s failed: %s", job.request_id, code)
        self._update(job, state=FAILED, error={"code": code, "message": message[:500]})

    async def _run(self, job: Job) -> None:
        loop = asyncio.get_running_loop()
        try:
            audio_path = await self._fetch(job)
            if audio_path is None:
                return
            await self._transcribe(job, audio_path, loop)
        except asyncio.CancelledError:
            if not job.terminal:
                self._update(job, state=CANCELLED, message="cancelled")
            raise
        except Exception as exc:  # noqa: BLE001 —— 任何未预期异常都必须落成终态，不能让请求悬挂
            logger.exception("request %s crashed", job.request_id)
            self._fail(job, "internal_error", f"{type(exc).__name__}: {exc}")
        finally:
            self._cleanup_files(job)

    async def _fetch(self, job: Job) -> Optional[str]:
        async with self._download_sem:
            if job.cancel_requested:
                return None
            self._update(job, state=RUNNING, phase=PHASE_FETCHING, percent=0, message="fetching audio")
            workdir = self._workdir(job)
            workdir.mkdir(parents=True, exist_ok=True)
            try:
                downloader = self._downloader_factory(workdir)
                path = await asyncio.to_thread(downloader.download_audio, job.source_url, "audio", job.max_bytes)
            except SourceError as exc:
                self._fail(job, exc.code, str(exc))
                return None
        if job.cancel_requested:
            return None
        self._progress(job, PHASE_FETCHING, 100, "audio fetched")
        return path

    async def _transcribe(self, job: Job, audio_path: str, loop: asyncio.AbstractEventLoop) -> None:
        self._progress(job, PHASE_PREPARING, 0, "waiting for transcription engine")
        async with self._engine_lock:
            if job.cancel_requested:
                return
            self._progress(job, PHASE_TRANSCRIBING, 0, "transcribing")

            def on_progress(stage: str, pct: int, message: str) -> None:
                # 引擎适配层在工作线程里回调：切回事件循环再改状态。
                loop.call_soon_threadsafe(self._progress, job, PHASE_TRANSCRIBING, pct, message)

            try:
                transcriber = self._transcriber_factory()
                result = await asyncio.to_thread(transcriber.transcribe, audio_path, on_progress, job.language)
            except EngineError as exc:
                self._fail(job, exc.code, str(exc))
                return
        if job.cancel_requested:
            return
        payload = {
            "text": result.text,
            "language": result.language or job.language or "",
            "duration": float(result.duration or 0.0),
        }
        self._persist_result(job, payload)
        self._update(job, state=COMPLETED, phase=PHASE_TRANSCRIBING, percent=100, message="completed", result=payload)

    # ── 结果保留（供 Cloudflare 延迟取回；重启后仍可读） ──

    def _result_path(self, provider_request_id: str) -> Path:
        return self._results_dir / f"{provider_request_id}.json"

    def _persist_result(self, job: Job, payload: dict[str, Any]) -> None:
        record = {
            "request_id": job.request_id,
            "provider_request_id": job.provider_request_id,
            "source_url": job.source_url,
            "completed_at": time.time(),
            "result": payload,
        }
        path = self._result_path(job.provider_request_id)
        temp = path.with_suffix(".json.part")
        try:
            temp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            temp.replace(path)
        except OSError:
            logger.warning("无法落盘已完成结果 %s（仅内存保留）", job.provider_request_id)

    def _load_persisted_results(self) -> None:
        cutoff = time.time() - self.result_ttl
        for path in self._results_dir.glob("tsr_*.json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                if float(record.get("completed_at", 0)) < cutoff:
                    path.unlink(missing_ok=True)
                    continue
                job = Job(
                    request_id=record["request_id"],
                    provider_request_id=record["provider_request_id"],
                    source_url=record["source_url"],
                    state=COMPLETED,
                    phase=PHASE_TRANSCRIBING,
                    percent=100,
                    message="completed",
                    result=record["result"],
                    created_at=float(record["completed_at"]),
                    updated_at=float(record["completed_at"]),
                )
            except (OSError, ValueError, KeyError, TypeError):
                path.unlink(missing_ok=True)
                continue
            self._by_provider_id[job.provider_request_id] = job
            self._by_request_id[job.request_id] = job

    def _forget(self, job: Job) -> None:
        self._by_provider_id.pop(job.provider_request_id, None)
        if self._by_request_id.get(job.request_id) is job:
            self._by_request_id.pop(job.request_id, None)
        self._result_path(job.provider_request_id).unlink(missing_ok=True)

    def sweep(self, now: Optional[float] = None) -> int:
        """回收超过 TTL 的终态请求（含落盘结果）。返回回收数量。"""
        current = time.time() if now is None else now
        expired = [
            job for job in self._by_provider_id.values()
            if job.terminal and current - job.updated_at > self.result_ttl
        ]
        for job in expired:
            self._forget(job)
        return len(expired)

    async def _sweep_loop(self) -> None:
        while True:
            await asyncio.sleep(300)
            try:
                self.sweep()
            except Exception:  # noqa: BLE001
                logger.exception("sweep failed")
