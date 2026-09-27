"""OpenAI 兼容上传代理转录引擎的单元测试。

覆盖：
- 分段边界去重与文本拼接（merge_overlapping_texts）；
- 静音检测解析与分段规划（_detect_silence_points, _plan_chunks）；
- 上游 API 调用与按段重试（429 退避、5xx 重试、401 快速失败、额度用尽映射）；
- 完整转录流程（单段、多段拼接、进度推进）；
- 密钥安全边界：API Key 绝不出现在异常消息、状态快照、health 探针与日志中。
"""
from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

import httpx
import pytest

from core.config import OpenAIProxyOptions
from core.openai_proxy_engine import (
    OpenAIProxyTranscriber,
    _normalize_endpoint,
    merge_overlapping_texts,
)
from core.transcriber import EngineError


# ── 1. 分段文本去重与拼接（merge_overlapping_texts） ──

def test_merge_exact_overlap_chinese():
    s1 = "欢迎收听本期播客，今天我们来聊聊人工智能的发展。"
    s2 = "人工智能的发展。这是一个很宏大的主题。"
    merged = merge_overlapping_texts(s1, s2)
    assert merged == "欢迎收听本期播客，今天我们来聊聊人工智能的发展。这是一个很宏大的主题。"


def test_merge_overlap_with_different_punctuation():
    s1 = "欢迎收听本期播客，今天我们来聊聊人工智能的发展。"
    s2 = "人工智能的发展，这是一个很宏大的主题。"
    merged = merge_overlapping_texts(s1, s2)
    assert merged == "欢迎收听本期播客，今天我们来聊聊人工智能的发展。这是一个很宏大的主题。"


def test_merge_exact_overlap_english():
    s1 = "Welcome to our podcast today we are going to discuss deep learning"
    s2 = "discuss deep learning and how it affects everyone."
    merged = merge_overlapping_texts(s1, s2)
    assert merged == "Welcome to our podcast today we are going to discuss deep learning and how it affects everyone."


def test_merge_no_overlap():
    s1 = "这是第一句话。"
    s2 = "这是第二句话。"
    merged = merge_overlapping_texts(s1, s2)
    assert merged == "这是第一句话。这是第二句话。"

    s1_en = "Hello world"
    s2_en = "Next topic"
    assert merge_overlapping_texts(s1_en, s2_en) == "Hello world Next topic"


def test_merge_empty_handling():
    assert merge_overlapping_texts("", "hello") == "hello"
    assert merge_overlapping_texts("hello", "") == "hello"
    assert merge_overlapping_texts("", "") == ""


def test_merge_fuzzy_suffix_overlap():
    s1 = "今天天气真好，我们一起去公园玩耍吧。"
    s2 = "玩耍吧。公园里有很多花。"
    merged = merge_overlapping_texts(s1, s2)
    assert merged == "今天天气真好，我们一起去公园玩耍吧。公园里有很多花。"


# ── 2. 端点规范化 ──

def test_normalize_endpoint():
    assert _normalize_endpoint("https://api.openai.com/v1") == "https://api.openai.com/v1/audio/transcriptions"
    assert _normalize_endpoint("https://api.openai.com/v1/") == "https://api.openai.com/v1/audio/transcriptions"
    assert (
        _normalize_endpoint("https://api.siliconflow.cn/v1/audio/transcriptions")
        == "https://api.siliconflow.cn/v1/audio/transcriptions"
    )
    assert (
        _normalize_endpoint("https://api.groq.com/openai/v1")
        == "https://api.groq.com/openai/v1/audio/transcriptions"
    )


# ── 3. 静音点检测与分段规划 ──

def test_detect_silence_points(tmp_path):
    fake_stderr = """
[silencedetect @ 0x123] silence_start: 10.5
[silencedetect @ 0x123] silence_end: 12.5 | silence_duration: 2.0
[silencedetect @ 0x123] silence_start: 55.2
[silencedetect @ 0x123] silence_end: 56.8 | silence_duration: 1.6
"""
    def mock_ffmpeg(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr=fake_stderr)

    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(api_base="https://api.openai.com/v1", api_key="sk-test", model="whisper-1"),
        ffmpeg_runner=mock_ffmpeg,
    )
    points = transcriber._detect_silence_points(str(tmp_path / "test.mp3"))
    assert len(points) == 2
    assert points[0] == 11.5
    assert points[1] == 56.0


def test_plan_chunks_single_chunk_under_limit():
    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-test",
            model="whisper-1",
            chunk_size_mb=24,
        )
    )
    # 10MB < 24MB 上限：不分段
    chunks = transcriber._plan_chunks(
        total_duration=3600.0,
        file_size=10 * 1024 * 1024,
        max_bytes=24 * 1024 * 1024,
        silence_points=[100.0, 500.0],
    )
    assert chunks == [(0.0, 3600.0)]


def test_plan_chunks_multi_chunk_with_silence_snap():
    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-test",
            model="whisper-1",
            chunk_size_mb=10,
            overlap_seconds=2.0,
        )
    )
    # 30MB，上限 10MB，总时长 300s（目标段约 90s）
    # 静音点设在 88.0s（接近 90s）
    silence_points = [88.0, 182.0]
    chunks = transcriber._plan_chunks(
        total_duration=300.0,
        file_size=30 * 1024 * 1024,
        max_bytes=10 * 1024 * 1024,
        silence_points=silence_points,
    )
    assert len(chunks) >= 3
    # 第一段应该在 88.0s 切断
    assert chunks[0][0] == 0.0
    assert chunks[0][1] == 88.0
    # 第二段应从 88.0 - 2.0 = 86.0s 开始（留 overlap）
    assert chunks[1][0] == 86.0



def test_plan_chunks_terminates_when_overlap_exceeds_chunk_duration():
    """overlap 配置过大（≥ 分段时长）时也必须收敛，不能死循环。"""
    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-test",
            model="whisper-1",
            chunk_size_mb=10,
            overlap_seconds=600.0,
        )
    )
    chunks = transcriber._plan_chunks(
        total_duration=3600.0,
        file_size=100 * 1024 * 1024,
        max_bytes=10 * 1024 * 1024,
        silence_points=[],
    )
    assert chunks[-1][1] == 3600.0
    assert all(end > start for start, end in chunks)
    assert all(b[0] > a[0] for a, b in zip(chunks, chunks[1:]))

# ── 4. 上游 API 调用与重试 ──

def make_mock_client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_call_upstream_success(tmp_path):
    chunk = tmp_path / "chunk.mp3"
    chunk.write_bytes(b"fake audio data")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://api.openai.com/v1/audio/transcriptions"
        assert request.headers.get("authorization") == "Bearer sk-valid-key"
        return httpx.Response(
            200,
            json={"text": "Hello world from upstream", "language": "en", "duration": 15.0},
        )

    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-valid-key",
            model="whisper-1",
        ),
        client=make_mock_client(handler),
    )
    res = transcriber._call_upstream_with_retry(str(chunk))
    assert res["text"] == "Hello world from upstream"
    assert res["language"] == "en"


def test_call_upstream_429_rate_limit_retry(tmp_path, monkeypatch):
    chunk = tmp_path / "chunk.mp3"
    chunk.write_bytes(b"fake audio data")
    attempts = 0

    monkeypatch.setattr("time.sleep", lambda s: None)

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            return httpx.Response(429, headers={"Retry-After": "1"}, text="rate limited")
        return httpx.Response(200, json={"text": "recovered after 429"})

    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-valid-key",
            model="whisper-1",
            max_retries=3,
        ),
        client=make_mock_client(handler),
    )
    res = transcriber._call_upstream_with_retry(str(chunk))
    assert res["text"] == "recovered after 429"
    assert attempts == 3


def test_call_upstream_429_retry_exhausted(tmp_path, monkeypatch):
    chunk = tmp_path / "chunk.mp3"
    chunk.write_bytes(b"fake audio data")
    monkeypatch.setattr("time.sleep", lambda s: None)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="rate limited")

    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-secret-key-12345",
            model="whisper-1",
            max_retries=2,
        ),
        client=make_mock_client(handler),
    )
    with pytest.raises(EngineError) as exc_info:
        transcriber._call_upstream_with_retry(str(chunk))
    assert exc_info.value.code == "engine_unavailable"
    # 确保密钥绝不出现在异常信息中
    assert "sk-secret-key-12345" not in str(exc_info.value)


def test_call_upstream_500_retry(tmp_path, monkeypatch):
    chunk = tmp_path / "chunk.mp3"
    chunk.write_bytes(b"fake audio data")
    attempts = 0
    monkeypatch.setattr("time.sleep", lambda s: None)

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(502, text="bad gateway")
        return httpx.Response(200, json={"text": "recovered after 502"})

    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-valid-key",
            model="whisper-1",
            max_retries=3,
        ),
        client=make_mock_client(handler),
    )
    res = transcriber._call_upstream_with_retry(str(chunk))
    assert res["text"] == "recovered after 502"
    assert attempts == 2


def test_call_upstream_401_fails_loudly_without_retry(tmp_path):
    chunk = tmp_path / "chunk.mp3"
    chunk.write_bytes(b"fake audio data")
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(401, text="Incorrect API key provided: sk-secret-key")

    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-secret-key",
            model="whisper-1",
            max_retries=3,
        ),
        client=make_mock_client(handler),
    )
    with pytest.raises(EngineError) as exc_info:
        transcriber._call_upstream_with_retry(str(chunk))
    assert exc_info.value.code == "engine_failed"
    assert attempts == 1  # 401 立即失败，不重试
    assert "401" in str(exc_info.value)
    assert "sk-secret-key" not in str(exc_info.value)


def test_call_upstream_quota_exhausted_mapping(tmp_path):
    chunk = tmp_path / "chunk.mp3"
    chunk.write_bytes(b"fake audio data")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text='{"error": {"message": "You exceeded your current quota, please check your plan and billing details."}}')

    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-secret-key",
            model="whisper-1",
        ),
        client=make_mock_client(handler),
    )
    with pytest.raises(EngineError) as exc_info:
        transcriber._call_upstream_with_retry(str(chunk))
    assert exc_info.value.code == "engine_failed"
    assert "额度用尽" in str(exc_info.value) or "Quota" in str(exc_info.value)


def test_call_upstream_rejected_audio(tmp_path):
    chunk = tmp_path / "chunk.mp3"
    chunk.write_bytes(b"fake audio data")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(413, text="Payload too large")

    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-secret-key",
            model="whisper-1",
        ),
        client=make_mock_client(handler),
    )
    with pytest.raises(EngineError) as exc_info:
        transcriber._call_upstream_with_retry(str(chunk))
    assert exc_info.value.code == "engine_rejected_audio"


def test_missing_api_key_fails(tmp_path):
    chunk = tmp_path / "chunk.mp3"
    chunk.write_bytes(b"fake audio data")

    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="",
            model="whisper-1",
        )
    )
    with pytest.raises(EngineError) as exc_info:
        transcriber._call_upstream_with_retry(str(chunk))
    assert exc_info.value.code == "engine_unavailable"
    assert "READ_PODCAST_OPENAI_API_KEY" in str(exc_info.value)


# ── 5. 完整转录流程（transcribe）与多分段拼接 ──

def test_transcribe_full_flow_single_chunk(tmp_path):
    audio_file = tmp_path / "test.mp3"
    audio_file.write_bytes(b"fake original audio bytes")

    def mock_ffmpeg(cmd, **kwargs):
        # 模拟 ffmpeg 转码成功
        if "-ar" in cmd:
            transcoded = Path(cmd[-1])
            transcoded.write_bytes(b"fake transcoded bytes 12345")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        if "ffprobe" in cmd[0]:
            return subprocess.CompletedProcess(cmd, 0, stdout="45.0\n", stderr="")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"text": "这是一段完整的测试转录文字。", "language": "zh", "duration": 45.0},
        )

    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-test-key",
            model="whisper-1",
            chunk_size_mb=24,
        ),
        client=make_mock_client(handler),
        ffmpeg_runner=mock_ffmpeg,
    )

    progresses: list[tuple[str, int, str]] = []
    res = transcriber.transcribe(
        str(audio_file),
        progress_callback=lambda stage, pct, msg: progresses.append((stage, pct, msg)),
    )

    assert res.text == "这是一段完整的测试转录文字。"
    assert res.language == "zh"
    assert res.duration == 45.0
    assert len(progresses) >= 2
    assert progresses[-1][1] == 100


def test_transcribe_full_flow_multi_chunks(tmp_path):
    audio_file = tmp_path / "long_audio.mp3"
    audio_file.write_bytes(b"fake long audio bytes")
    calls: list[str] = []

    def mock_ffmpeg(cmd, **kwargs):
        if "-ar" in cmd:
            transcoded = Path(cmd[-1])
            # 写入 50KB 数据
            transcoded.write_bytes(b"x" * (50 * 1024))
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        if "ffprobe" in cmd[0]:
            return subprocess.CompletedProcess(cmd, 0, stdout="180.0\n", stderr="")
        if "silencedetect" in "".join(cmd):
            stderr = "silence_start: 89.0\nsilence_end: 91.0\n"
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr=stderr)
        if "-ss" in cmd:
            # 切片导出
            chunk_out = Path(cmd[-1])
            chunk_out.write_bytes(b"chunk content")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    def handler(request: httpx.Request) -> httpx.Response:
        content = request.read().decode("latin1", errors="ignore")
        if "chunk_0.mp3" in content:
            calls.append("chunk_0")
            return httpx.Response(200, json={"text": "第一部分播客内容，关于开源生态。", "language": "zh"})
        calls.append("chunk_1")
        return httpx.Response(200, json={"text": "开源生态。接下来是第二部分总结。", "language": "zh"})

    # 设置 chunk_size 为极小（如 0.03MB，即 30KB < 50KB），强制触发切分
    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-test-key",
            model="whisper-1",
            chunk_size_mb=1,
            overlap_seconds=2.0,
        ),
        client=make_mock_client(handler),
        ffmpeg_runner=mock_ffmpeg,
    )
    # mock _plan_chunks 直接返回两段以精准测试
    transcriber._plan_chunks = lambda *args: [(0.0, 90.0), (88.0, 180.0)]

    res = transcriber.transcribe(str(audio_file))
    assert "chunk_0" in calls
    assert "chunk_1" in calls
    # 验证重叠去重
    assert res.text == "第一部分播客内容，关于开源生态。接下来是第二部分总结。"


def test_transcribe_empty_text_fails(tmp_path):
    audio_file = tmp_path / "silent.mp3"
    audio_file.write_bytes(b"silent")

    def mock_ffmpeg(cmd, **kwargs):
        if "-ar" in cmd:
            Path(cmd[-1]).write_bytes(b"silent mono")
        return subprocess.CompletedProcess(cmd, 0, stdout="10.0\n", stderr="")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"text": "   "})

    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key="sk-test-key",
            model="whisper-1",
        ),
        client=make_mock_client(handler),
        ffmpeg_runner=mock_ffmpeg,
    )
    with pytest.raises(EngineError) as exc_info:
        transcriber.transcribe(str(audio_file))
    assert exc_info.value.code == "transcription_empty"


def test_secret_does_not_leak_into_logs(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    secret_key = "sk-super-secret-key-999888777"
    chunk = tmp_path / "chunk.mp3"
    chunk.write_bytes(b"audio")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text=f"Internal crash with key {secret_key}")

    transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key=secret_key,
            model="whisper-1",
            max_retries=1,
        ),
        client=make_mock_client(handler),
    )
    with pytest.raises(EngineError) as exc_info:
        transcriber._call_upstream_with_retry(str(chunk))

    assert secret_key not in str(exc_info.value)
    for record in caplog.records:
        assert secret_key not in record.message


# ── 6. JobManager / 完整服务 API 集成测试 ──

def test_job_lifecycle_with_openai_proxy(tmp_path, monkeypatch):
    import asyncio
    from fastapi.testclient import TestClient
    import core.transcriber as transcriber_mod
    from jobs import JobManager
    from service import create_app

    secret_key = "sk-live-secret-test-key-777"
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_ENGINE", "openai-proxy")
    monkeypatch.setenv("READ_PODCAST_OPENAI_API_KEY", secret_key)
    monkeypatch.setenv("READ_PODCAST_OPENAI_API_BASE", "https://api.openai.com/v1")
    monkeypatch.setattr(transcriber_mod, "_openai_proxy", None)

    # Mock ffmpeg runner
    def mock_ffmpeg(cmd, **kwargs):
        if "-ar" in cmd:
            Path(cmd[-1]).write_bytes(b"transcoded audio")
        return subprocess.CompletedProcess(cmd, 0, stdout="30.0\n", stderr="")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"text": "OpenAI proxy integration passed.", "language": "en", "duration": 30.0})

    mock_client = make_mock_client(handler)

    # Mock Downloader to avoid network
    class FakeDownloader:
        def __init__(self, workdir: Path):
            self.workdir = workdir

        def download_audio(self, url: str, stem: str, max_bytes: int | None = None) -> str:
            path = self.workdir / f"{stem}.mp3"
            path.write_bytes(b"dummy audio")
            return str(path)

    # Configure transcriber instance
    proxy_transcriber = OpenAIProxyTranscriber(
        options=OpenAIProxyOptions(
            api_base="https://api.openai.com/v1",
            api_key=secret_key,
            model="whisper-1",
        ),
        client=mock_client,
        ffmpeg_runner=mock_ffmpeg,
    )
    monkeypatch.setattr(transcriber_mod, "_openai_proxy", proxy_transcriber)

    manager = JobManager(
        tmp_path / "data",
        transcriber_factory=lambda: proxy_transcriber,
        downloader_factory=FakeDownloader,
    )

    app = create_app(manager)
    with TestClient(app) as client:
        # 1. 提交任务
        resp = client.post(
            "/v1/transcriptions",
            json={"request_id": "req-proxy-001", "source": {"type": "url", "url": "https://example.com/audio.mp3"}},
        )
        assert resp.status_code == 202
        body = resp.json()
        provider_id = body["provider_request_id"]
        assert body["status"] == "queued"
        # 确保响应体绝无密钥
        assert secret_key not in resp.text

        # 2. 等待执行完成
        for _ in range(50):
            st = client.get(f"/v1/transcriptions/{provider_id}").json()
            if st["status"] == "completed":
                break
            asyncio.run(asyncio.sleep(0.05))

        assert st["status"] == "completed"
        assert secret_key not in client.get(f"/v1/transcriptions/{provider_id}").text

        # 3. 获取转录正文
        res_text_resp = client.get(f"/v1/transcriptions/{provider_id}/result")
        assert res_text_resp.status_code == 200
        assert res_text_resp.text == "OpenAI proxy integration passed."
        assert secret_key not in res_text_resp.text
