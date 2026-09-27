"""Faster-Whisper 引擎（进程内 CPU / CUDA）：假模型下的行为与完整任务流程。

CI 不下载任何真实模型：模型加载器被替换为 fake，只验证服务侧行为——模型句柄复用、
进度映射、结果组装、稳定 ``EngineError`` code，以及经 ``JobManager`` 的完整任务流程
（fetch → transcribe → completed，正文可取回）。
"""
from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path

import pytest

from core.config import FasterWhisperOptions
from core.faster_whisper_engine import FasterWhisperTranscriber
from core.transcriber import EngineError
from jobs import COMPLETED, FAILED, JobManager

URL = "https://cdn.example.com/ep/1.mp3"


class FakeSegment:
    def __init__(self, end: float, text: str):
        self.end = end
        self.text = text


class FakeInfo:
    duration = 100.0
    language = "zh"


class FakeWhisperModel:
    """按脚本产出分段 / 抛错；记录调用参数。"""

    segments: list[FakeSegment] = [FakeSegment(50.0, " hello "), FakeSegment(100.0, " world")]
    info: FakeInfo = FakeInfo()
    error: Exception | None = None
    gate: threading.Event | None = None
    calls: list[dict] = []

    def transcribe(self, audio, language=None, **kwargs):
        FakeWhisperModel.calls.append({"audio": audio, "language": language})
        assert Path(audio).exists()
        if FakeWhisperModel.gate is not None:
            FakeWhisperModel.gate.wait(timeout=5)
        if FakeWhisperModel.error is not None:
            raise FakeWhisperModel.error
        return iter(FakeWhisperModel.segments), FakeWhisperModel.info


@pytest.fixture(autouse=True)
def reset_fake_model():
    FakeWhisperModel.segments = [FakeSegment(50.0, " hello "), FakeSegment(100.0, " world")]
    FakeWhisperModel.info = FakeInfo()
    FakeWhisperModel.error = None
    FakeWhisperModel.gate = None
    FakeWhisperModel.calls = []
    yield


def make_audio(tmp_path: Path) -> str:
    path = tmp_path / "475.mp3"
    path.write_bytes(b"\x00" * 2048)
    return str(path)


def make_transcriber(loader_calls: list | None = None) -> FasterWhisperTranscriber:
    def loader(options: FasterWhisperOptions):
        if loader_calls is not None:
            loader_calls.append(options)
        return FakeWhisperModel()

    return FasterWhisperTranscriber(model_loader=loader)


def engine_code(fn, *args, **kwargs) -> str:
    with pytest.raises(EngineError) as info:
        fn(*args, **kwargs)
    return info.value.code


# ── 转录行为 ──

def test_transcribe_joins_segments_and_reports_progress(tmp_path):
    audio = make_audio(tmp_path)
    stages = []

    result = make_transcriber().transcribe(str(audio), lambda stage, pct, msg: stages.append((stage, pct)), language=None)

    assert result.text == " hello  world".strip()
    assert result.language == "zh"
    assert result.duration == 100.0
    # 进度：起步 10 → 分段推进（10–95 区间）→ 完成 100。
    assert stages[0] == ("transcribing", 10)
    assert stages[1] == ("transcribing", 10 + round(0.50 * 85))
    assert stages[2] == ("transcribing", 10 + round(1.00 * 85))
    assert stages[-1] == ("transcribing", 100)
    assert stages[-1][1] > stages[2][1]


def test_transcribe_forwards_language_and_reuses_the_model_handle(tmp_path):
    audio = make_audio(tmp_path)
    loader_calls: list = []
    transcriber = make_transcriber(loader_calls)

    transcriber.transcribe(str(audio), language="en")
    transcriber.transcribe(str(audio), language="en")

    assert [call["language"] for call in FakeWhisperModel.calls] == ["en", "en"]
    assert len(loader_calls) == 1  # 模型惰性加载一次后常驻复用


def test_transcribe_empty_text_is_transcription_empty(tmp_path):
    FakeWhisperModel.segments = [FakeSegment(1.0, ""), FakeSegment(2.0, "  ")]
    assert engine_code(make_transcriber().transcribe, make_audio(tmp_path)) == "transcription_empty"


def test_missing_audio_is_engine_failed_and_never_loads_the_model(tmp_path):
    loader_calls: list = []
    assert engine_code(make_transcriber(loader_calls).transcribe, str(tmp_path / "missing.mp3")) == "engine_failed"
    assert loader_calls == []


def test_model_load_failure_is_engine_unavailable(tmp_path):
    def broken_loader(options):
        raise RuntimeError("network down")

    transcriber = FasterWhisperTranscriber(model_loader=broken_loader)
    assert engine_code(transcriber.transcribe, make_audio(tmp_path)) == "engine_unavailable"


def test_import_error_during_transcription_is_engine_unavailable(tmp_path):
    FakeWhisperModel.error = ImportError("no module named faster_whisper")
    assert engine_code(make_transcriber().transcribe, make_audio(tmp_path)) == "engine_unavailable"


def test_runtime_error_during_transcription_is_engine_failed(tmp_path):
    FakeWhisperModel.error = RuntimeError("cuda oom")
    assert engine_code(make_transcriber().transcribe, make_audio(tmp_path)) == "engine_failed"


# ── 完整任务流程（fetch → transcribe → completed） ──


class FakeDownloader:
    def __init__(self, directory):
        self.directory = Path(directory)

    def download_audio(self, url, filename_base, max_bytes=None):
        path = self.directory / f"{filename_base}.mp3"
        path.write_bytes(b"audio")
        return str(path)


async def settle(job, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not job.terminal:
        if time.monotonic() > deadline:
            raise AssertionError(f"job stuck in {job.state}/{job.phase}")
        await asyncio.sleep(0.01)
    return job


def test_full_job_flow_with_fake_engine_completes(tmp_path):
    async def scenario():
        manager = JobManager(
            tmp_path,
            transcriber_factory=make_transcriber,
            downloader_factory=FakeDownloader,
        )
        manager.start()
        job, created = manager.submit("task-1:attempt-1", URL, language="zh")
        assert created
        await settle(job)
        assert job.state == COMPLETED
        snapshot = job.snapshot()
        assert snapshot["result"] == {"language": "zh", "duration": 100.0}
        assert job.result_text() == "hello  world"
        # 临时音频已清理；进度到达 100。
        assert not (tmp_path / "requests" / job.provider_request_id).exists()
        assert (job.percent, job.phase) == (100, "transcribing")
        await manager.stop()

    asyncio.run(scenario())


def test_engine_failure_fails_the_job_with_the_stable_code(tmp_path):
    FakeWhisperModel.error = RuntimeError("boom")

    async def scenario():
        manager = JobManager(
            tmp_path,
            transcriber_factory=make_transcriber,
            downloader_factory=FakeDownloader,
        )
        manager.start()
        job, _ = manager.submit("r1", URL)
        await settle(job)
        assert job.state == FAILED
        assert job.snapshot()["error"]["code"] == "engine_failed"
        await manager.stop()

    asyncio.run(scenario())
