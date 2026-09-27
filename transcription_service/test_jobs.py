"""JobManager：一次外部转录请求的运行态（ephemeral compute state）。

不变式：
- request_id 幂等：同一请求重复提交不重复计算；
- 失败 / 已取消可以用同一 request_id 重新提交（新的计算）；
- 已完成结果落盘保留：进程重启后仍可取回，不必重新转录；进行中的请求随进程消亡（Cloudflare 自行重提）；
- 任何未预期异常都落成终态，请求不会悬挂；
- 本服务对业务状态（task / attempt / retry / raw 持久化）一无所知。
"""
from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path

import pytest

import jobs as jobs_module
from core.downloader import SourceFetchFailed, SourceTooLarge
from core.transcriber import EngineError, TranscriptionResult
from jobs import (
    CANCELLED,
    COMPLETED,
    FAILED,
    PHASE_FETCHING,
    PHASE_TRANSCRIBING,
    QUEUED,
    ApiError,
    JobManager,
)

URL = "https://cdn.example.com/ep/1.mp3"


class FakeDownloader:
    """按脚本产出音频或抛错；记录调用参数。"""

    calls: list[dict] = []
    behavior = None  # callable(url) -> raises or None
    gate: threading.Event | None = None

    def __init__(self, directory):
        self.directory = Path(directory)

    def download_audio(self, url, filename_base, max_bytes=None):
        FakeDownloader.calls.append({"url": url, "max_bytes": max_bytes})
        if FakeDownloader.gate is not None:
            FakeDownloader.gate.wait(timeout=5)
        if FakeDownloader.behavior:
            FakeDownloader.behavior(url)
        path = self.directory / f"{filename_base}.mp3"
        path.write_bytes(b"audio")
        return str(path)


class FakeTranscriber:
    gate: threading.Event | None = None
    behavior = None
    progress_steps = ((20, "chunk 1/5"), (60, "chunk 3/5"))
    calls: list[dict] = []

    def transcribe(self, audio_file, progress_callback=None, language=None):
        FakeTranscriber.calls.append({"audio": audio_file, "language": language})
        assert Path(audio_file).exists()
        if progress_callback:
            for pct, message in FakeTranscriber.progress_steps:
                progress_callback("transcribing", pct, message)
        if FakeTranscriber.gate is not None:
            FakeTranscriber.gate.wait(timeout=5)
        if FakeTranscriber.behavior:
            FakeTranscriber.behavior()
        return TranscriptionResult(text="这是转录文本。" * 40, language=language or "zh", duration=123.5)


@pytest.fixture(autouse=True)
def reset_fakes():
    FakeDownloader.calls = []
    FakeDownloader.behavior = None
    FakeDownloader.gate = None
    FakeTranscriber.gate = None
    FakeTranscriber.behavior = None
    FakeTranscriber.calls = []
    yield


def make_manager(tmp_path, **overrides) -> JobManager:
    manager = JobManager(tmp_path, transcriber_factory=FakeTranscriber, downloader_factory=FakeDownloader)
    for key, value in overrides.items():
        setattr(manager, key, value)
    return manager


async def settle(job, timeout=5.0):
    """等到请求进入终态。"""
    deadline = time.monotonic() + timeout
    while not job.terminal:
        if time.monotonic() > deadline:
            raise AssertionError(f"job stuck in {job.state}/{job.phase}")
        await asyncio.sleep(0.01)
    return job


def run(coro):
    return asyncio.run(coro)


def test_happy_path_returns_result_and_cleans_temp_files(tmp_path):
    async def scenario():
        manager = make_manager(tmp_path)
        manager.start()
        job, created = manager.submit("task-1:attempt-1", URL, language="zh")
        assert created and job.state == QUEUED
        await settle(job)
        assert job.state == COMPLETED
        snapshot = job.snapshot()
        assert snapshot["request_id"] == "task-1:attempt-1"
        assert snapshot["provider_request_id"].startswith("tsr_")
        # 状态快照只有元数据；正文单独从 result_text() 取（HTTP 层的 /result）
        assert set(snapshot["result"]) == {"language", "duration"}
        assert snapshot["result"]["language"] == "zh"
        assert snapshot["result"]["duration"] == 123.5
        assert len(job.result_text()) > 200
        # 临时音频已清理
        assert not (tmp_path / "requests" / job.provider_request_id).exists()
        await manager.stop()

    run(scenario())


def test_progress_is_reported_by_phase(tmp_path):
    async def scenario():
        FakeTranscriber.gate = threading.Event()
        manager = make_manager(tmp_path)
        manager.start()
        job, _ = manager.submit("r1", URL)
        for _ in range(200):
            if job.phase == PHASE_TRANSCRIBING and job.percent >= 60:
                break
            await asyncio.sleep(0.01)
        assert job.state == "running"
        assert job.phase == PHASE_TRANSCRIBING and job.percent == 60
        assert job.message == "chunk 3/5"
        FakeTranscriber.gate.set()
        await settle(job)
        await manager.stop()

    run(scenario())


def test_submit_is_idempotent_by_request_id(tmp_path):
    async def scenario():
        manager = make_manager(tmp_path)
        manager.start()
        first, created_first = manager.submit("task-1:attempt-1", URL)
        second, created_second = manager.submit("task-1:attempt-1", URL)
        assert created_first and not created_second
        assert first is second
        await settle(first)
        # 已完成后重复提交仍是同一个结果，不重新计算。
        third, created_third = manager.submit("task-1:attempt-1", URL)
        assert third is first and not created_third
        assert len(FakeDownloader.calls) == 1
        assert len(FakeTranscriber.calls) == 1
        await manager.stop()

    run(scenario())


def test_same_request_id_with_different_source_conflicts(tmp_path):
    async def scenario():
        manager = make_manager(tmp_path)
        manager.start()
        manager.submit("r1", URL)
        with pytest.raises(ApiError) as info:
            manager.submit("r1", "https://other.example.com/x.mp3")
        assert info.value.status == 409 and info.value.code == "request_conflict"
        await manager.stop()

    run(scenario())


@pytest.mark.parametrize("bad", ["", "a b", "x" * 129, "a/b", "任务"])
def test_invalid_request_id_is_rejected(tmp_path, bad):
    async def scenario():
        manager = make_manager(tmp_path)
        manager.start()
        with pytest.raises(ApiError) as info:
            manager.submit(bad, URL)
        assert info.value.status == 400
        await manager.stop()

    run(scenario())


def test_source_error_is_reported_with_stable_code_and_can_be_resubmitted(tmp_path):
    async def scenario():
        def too_large(url):
            raise SourceTooLarge("too big")

        FakeDownloader.behavior = too_large
        manager = make_manager(tmp_path)
        manager.start()
        job, _ = manager.submit("r1", URL, max_bytes=209_715_200)
        await settle(job)
        assert job.state == FAILED
        assert job.snapshot()["error"]["code"] == "source_too_large"
        assert FakeDownloader.calls[0]["max_bytes"] == 209_715_200

        # 失败的请求可以用同一 request_id 重新提交（新的计算，新的 provider id）。
        FakeDownloader.behavior = None
        retry, created = manager.submit("r1", URL)
        assert created and retry is not job
        assert retry.provider_request_id != job.provider_request_id
        await settle(retry)
        assert retry.state == COMPLETED
        await manager.stop()

    run(scenario())


def test_engine_error_code_is_passed_through_verbatim(tmp_path):
    async def scenario():
        def unavailable():
            raise EngineError("engine_unavailable", "engine down")

        FakeTranscriber.behavior = unavailable
        manager = make_manager(tmp_path)
        manager.start()
        job, _ = manager.submit("r1", URL)
        await settle(job)
        assert job.state == FAILED
        assert job.snapshot()["error"]["code"] == "engine_unavailable"
        assert "result" not in job.snapshot()
        await manager.stop()

    run(scenario())


def test_unexpected_exception_becomes_internal_error_not_a_hanging_request(tmp_path):
    async def scenario():
        def crash(url):
            raise RuntimeError("boom")

        FakeDownloader.behavior = crash
        manager = make_manager(tmp_path)
        manager.start()
        job, _ = manager.submit("r1", URL)
        await settle(job)
        assert job.state == FAILED
        assert job.snapshot()["error"]["code"] == "internal_error"
        await manager.stop()

    run(scenario())


def test_cancel_running_request_discards_result_and_frees_files(tmp_path):
    async def scenario():
        FakeTranscriber.gate = threading.Event()
        manager = make_manager(tmp_path)
        manager.start()
        job, _ = manager.submit("r1", URL)
        for _ in range(200):
            if job.phase == PHASE_TRANSCRIBING:
                break
            await asyncio.sleep(0.01)
        cancelled = manager.cancel(job.provider_request_id)
        assert cancelled.state == CANCELLED
        FakeTranscriber.gate.set()  # 引擎线程此时才结束——结果必须被丢弃
        await asyncio.sleep(0.2)
        assert job.state == CANCELLED and job.result is None
        assert not (tmp_path / "requests" / job.provider_request_id).exists()
        assert not (tmp_path / "results" / f"{job.provider_request_id}.json").exists()
        await manager.stop()

    run(scenario())


def test_cancel_queued_request_never_starts_work(tmp_path):
    async def scenario():
        FakeDownloader.gate = threading.Event()
        manager = make_manager(tmp_path)
        manager._download_sem = asyncio.Semaphore(1)
        manager.start()
        first, _ = manager.submit("r1", URL)
        second, _ = manager.submit("r2", "https://cdn.example.com/ep/2.mp3")
        await asyncio.sleep(0.05)
        assert second.state == QUEUED
        manager.cancel(second.provider_request_id)
        FakeDownloader.gate.set()
        await settle(first)
        await asyncio.sleep(0.05)
        assert second.state == CANCELLED
        assert [c["url"] for c in FakeDownloader.calls] == [URL]
        await manager.stop()

    run(scenario())


def test_cancel_of_finished_request_releases_its_result(tmp_path):
    async def scenario():
        manager = make_manager(tmp_path)
        manager.start()
        job, _ = manager.submit("r1", URL)
        await settle(job)
        assert (tmp_path / "results" / f"{job.provider_request_id}.json").exists()
        manager.cancel(job.provider_request_id)
        with pytest.raises(ApiError) as info:
            manager.get(job.provider_request_id)
        assert info.value.status == 404
        assert not (tmp_path / "results" / f"{job.provider_request_id}.json").exists()
        await manager.stop()

    run(scenario())


def test_unknown_request_is_404(tmp_path):
    manager = make_manager(tmp_path)
    with pytest.raises(ApiError) as info:
        manager.get("tsr_nope")
    assert info.value.status == 404 and info.value.code == "unknown_request"


def test_completed_result_survives_restart_and_is_not_recomputed(tmp_path):
    async def scenario():
        first_process = make_manager(tmp_path)
        first_process.start()
        job, _ = first_process.submit("task-1:attempt-1", URL)
        await settle(job)
        await first_process.stop()

        second_process = make_manager(tmp_path)
        second_process.start()
        reloaded = second_process.get(job.provider_request_id)
        assert reloaded.state == COMPLETED
        assert reloaded.snapshot()["result"] == job.snapshot()["result"]
        # 正文也随结果一起恢复（Cloudflare 可能稍后才来取 /result）
        assert reloaded.result_text() == job.result_text()
        # 同一 request_id 重新提交 → 直接命中，不重新下载 / 转录。
        FakeDownloader.calls.clear()
        again, created = second_process.submit("task-1:attempt-1", URL)
        assert again is reloaded and not created
        assert FakeDownloader.calls == []
        await second_process.stop()

    run(scenario())


def test_in_flight_requests_do_not_survive_restart(tmp_path):
    async def scenario():
        FakeTranscriber.gate = threading.Event()
        first_process = make_manager(tmp_path)
        first_process.start()
        job, _ = first_process.submit("r1", URL)
        for _ in range(200):
            if job.phase == PHASE_TRANSCRIBING:
                break
            await asyncio.sleep(0.01)
        await first_process.stop()
        FakeTranscriber.gate.set()

        second_process = make_manager(tmp_path)
        second_process.start()
        with pytest.raises(ApiError) as info:
            second_process.get(job.provider_request_id)
        assert info.value.status == 404  # Cloudflare 据此决定重新提交
        # 遗留的临时音频随进程消亡一并清掉。
        assert list((tmp_path / "requests").iterdir()) == []
        await second_process.stop()

    run(scenario())


def test_active_request_limit_returns_busy(tmp_path):
    async def scenario():
        FakeDownloader.gate = threading.Event()
        manager = make_manager(tmp_path, max_active=2)
        manager.start()
        manager.submit("r1", URL)
        manager.submit("r2", URL + "?2")
        with pytest.raises(ApiError) as info:
            manager.submit("r3", URL + "?3")
        assert info.value.status == 429 and info.value.code == "busy"
        FakeDownloader.gate.set()
        await manager.stop()

    run(scenario())


def test_sweep_reclaims_only_expired_terminal_requests(tmp_path):
    async def scenario():
        manager = make_manager(tmp_path)
        manager.start()
        done, _ = manager.submit("r1", URL)
        await settle(done)
        assert manager.sweep() == 0
        assert manager.sweep(now=time.time() + manager.result_ttl + 10) == 1
        with pytest.raises(ApiError):
            manager.get(done.provider_request_id)
        assert not (tmp_path / "results" / f"{done.provider_request_id}.json").exists()
        await manager.stop()

    run(scenario())


def test_expired_persisted_results_are_dropped_on_startup(tmp_path):
    async def scenario():
        first = make_manager(tmp_path)
        first.start()
        job, _ = first.submit("r1", URL)
        await settle(job)
        await first.stop()

        second = make_manager(tmp_path)
        second.result_ttl = 60
        stale = tmp_path / "results" / f"{job.provider_request_id}.json"
        import json, os

        record = json.loads(stale.read_text(encoding="utf-8"))
        record["completed_at"] = time.time() - 3600
        stale.write_text(json.dumps(record), encoding="utf-8")
        second.start()
        with pytest.raises(ApiError):
            second.get(job.provider_request_id)
        assert not stale.exists()
        await second.stop()

    run(scenario())


def test_long_poll_wakes_on_change_and_returns_immediately_when_terminal(tmp_path):
    async def scenario():
        FakeTranscriber.gate = threading.Event()
        manager = make_manager(tmp_path)
        manager.start()
        job, _ = manager.submit("r1", URL)
        for _ in range(200):
            if job.phase == PHASE_TRANSCRIBING:
                break
            await asyncio.sleep(0.01)

        # 有进度变化 / 状态变化时提前唤醒（远早于 timeout）
        started = time.monotonic()
        waiter = asyncio.create_task(manager.wait_for_change(job, timeout=5))
        await asyncio.sleep(0.05)
        FakeTranscriber.gate.set()
        await waiter
        assert time.monotonic() - started < 2

        await settle(job)
        started = time.monotonic()
        await manager.wait_for_change(job, timeout=5)  # 终态：立即返回
        assert time.monotonic() - started < 0.5
        await manager.stop()

    run(scenario())


def test_long_poll_times_out_without_changes(tmp_path):
    async def scenario():
        FakeTranscriber.gate = threading.Event()
        manager = make_manager(tmp_path)
        manager.start()
        job, _ = manager.submit("r1", URL)
        for _ in range(200):
            if job.phase == PHASE_TRANSCRIBING and job.percent == 60:
                break
            await asyncio.sleep(0.01)
        started = time.monotonic()
        await manager.wait_for_change(job, timeout=0.2)
        assert 0.15 <= time.monotonic() - started < 1
        FakeTranscriber.gate.set()
        await manager.stop()

    run(scenario())


def test_language_option_reaches_the_engine(tmp_path):
    async def scenario():
        manager = make_manager(tmp_path)
        manager.start()
        job, _ = manager.submit("r1", URL, language="en")
        await settle(job)
        assert FakeTranscriber.calls[0]["language"] == "en"
        await manager.stop()

    run(scenario())


def test_source_fetch_failure_is_retryable_code(tmp_path):
    async def scenario():
        def flaky(url):
            raise SourceFetchFailed("network")

        FakeDownloader.behavior = flaky
        manager = make_manager(tmp_path)
        manager.start()
        job, _ = manager.submit("r1", URL)
        await settle(job)
        assert job.snapshot()["error"]["code"] == "source_fetch_failed"
        await manager.stop()

    run(scenario())


def test_service_module_keeps_no_business_lifecycle_state():
    """架构护栏：本服务不得持有 Cloudflare 的业务概念。"""
    source = Path(jobs_module.__file__).read_text(encoding="utf-8")
    for forbidden in ("reclaim", "reconcile", "attempt_id", "current_attempt", "waiting_worker", "EDGE_CALLBACK"):
        assert forbidden not in source
