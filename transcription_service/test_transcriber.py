"""转录引擎适配（Transcription Engine adapter）的单元测试。

Reference deployment 只有本机 MLX Whisper 一条路径：这里验证内建端点、语言透传，
以及失败时带稳定 ``code`` 的 ``EngineError`` 分类（这些 code 会原样上报给 Cloudflare，
由它判定是否重试）。服务不持有任何引擎令牌。
"""
from __future__ import annotations

from pathlib import Path

import httpx
import pytest

import core.transcriber as transcriber
from core.config import MLX_ENDPOINT
from core.transcriber import (
    EngineError,
    TranscriptionResult,
    WhisperApiTranscriber,
    get_transcriber,
)


def make_audio(path, size=2048):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x00" * size)
    return path


class FakeHttpResponse:
    def __init__(self, *, json_body=None, text="", status_code=200, content_type="application/json"):
        self._json = json_body
        self.text = text
        self.status_code = status_code
        self.headers = {"content-type": content_type}

    def json(self):
        if self._json is None:
            raise ValueError("no json body")
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("bad status", request=None, response=self)


def patch_httpx(monkeypatch, response, *, track=None):
    """替换 httpx.post，返回调用记录。"""
    calls = track if track is not None else []

    def fake_post(url, **kwargs):
        calls.append({"url": url, "kwargs": kwargs})
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(transcriber.httpx, "post", fake_post)
    return calls


def engine_code(transcribe, *args, **kwargs):
    with pytest.raises(EngineError) as info:
        transcribe(*args, **kwargs)
    return info.value.code


# ── 内建引擎（无配置、无令牌） ──

def test_default_transcriber_targets_the_local_mlx_endpoint():
    t = get_transcriber()
    assert isinstance(t, WhisperApiTranscriber)
    assert t.api_url == f"{MLX_ENDPOINT}/transcribe"


def test_mlx_endpoint_is_loopback():
    assert MLX_ENDPOINT == "http://127.0.0.1:21567"


def test_mlx_api_url_normalization_is_idempotent():
    assert WhisperApiTranscriber("http://h:21567/transcribe").api_url == "http://h:21567/transcribe"
    assert WhisperApiTranscriber("http://h:21567/").api_url == "http://h:21567/transcribe"


def test_transcriber_carries_no_credentials():
    """MLX 只在回环地址上，由本服务独占消费：请求头里没有认证信息。"""
    assert get_transcriber()._headers() is None
    assert get_transcriber()._headers("req-1") == {"X-Read-Podcast-Request-ID": "req-1"}
    source = Path(transcriber.__file__).read_text(encoding="utf-8")
    for forbidden in ("Authorization", "API_TOKEN", "API_KEY", "getenv", "environ"):
        assert forbidden not in source


def test_transcription_result_from_dict_defaults():
    result = TranscriptionResult.from_dict({})
    assert result.text == ""
    assert result.segments == []
    assert result.language is None


# ── 转录 ──

def test_transcribe_missing_audio_is_engine_failed(tmp_path, monkeypatch):
    calls = patch_httpx(monkeypatch, FakeHttpResponse(json_body={"text": "x"}))
    assert engine_code(get_transcriber().transcribe, str(tmp_path / "missing.mp3")) == "engine_failed"
    assert calls == []


def test_transcribe_uploads_audio_to_the_local_engine(tmp_path, monkeypatch):
    audio = make_audio(tmp_path / "475.mp3")
    calls = patch_httpx(monkeypatch, FakeHttpResponse(json_body={"text": "转录结果", "language": "zh", "duration": 12.5}))

    result = get_transcriber().transcribe(str(audio))

    assert result.text == "转录结果"
    assert result.language == "zh"
    assert calls[0]["url"] == f"{MLX_ENDPOINT}/transcribe"
    assert "file" in calls[0]["kwargs"]["files"]


def test_transcribe_forwards_language_option(tmp_path, monkeypatch):
    audio = make_audio(tmp_path / "475.mp3")
    calls = patch_httpx(monkeypatch, FakeHttpResponse(json_body={"text": "ok"}))

    get_transcriber().transcribe(str(audio), language="en")

    assert calls[0]["kwargs"]["data"] == {"language": "en"}


@pytest.mark.parametrize("text", ["", "   \n"])
def test_transcribe_empty_text_is_transcription_empty(tmp_path, monkeypatch, text):
    audio = make_audio(tmp_path / "475.mp3")
    patch_httpx(monkeypatch, FakeHttpResponse(json_body={"text": text}))

    assert engine_code(get_transcriber().transcribe, str(audio)) == "transcription_empty"


def test_transcribe_5xx_is_engine_unavailable(tmp_path, monkeypatch):
    audio = make_audio(tmp_path / "475.mp3")
    patch_httpx(monkeypatch, FakeHttpResponse(status_code=500, json_body={"text": "x"}))

    assert engine_code(get_transcriber().transcribe, str(audio)) == "engine_unavailable"


def test_transcribe_transport_error_is_engine_unavailable(tmp_path, monkeypatch):
    audio = make_audio(tmp_path / "475.mp3")
    patch_httpx(monkeypatch, httpx.ConnectError("refused"))

    assert engine_code(get_transcriber().transcribe, str(audio)) == "engine_unavailable"


def test_transcribe_413_is_engine_rejected_audio(tmp_path, monkeypatch):
    audio = make_audio(tmp_path / "475.mp3")
    patch_httpx(monkeypatch, FakeHttpResponse(status_code=413, json_body={"detail": "too big"}))

    assert engine_code(get_transcriber().transcribe, str(audio)) == "engine_rejected_audio"


def test_transcribe_reports_progress_and_cleans_up(tmp_path, monkeypatch):
    audio = make_audio(tmp_path / "475.mp3")
    patch_httpx(monkeypatch, FakeHttpResponse(json_body={"text": "结果"}))
    deleted = []
    monkeypatch.setattr(transcriber.httpx, "delete", lambda url, **kw: deleted.append(url))

    stages = []
    result = get_transcriber().transcribe(str(audio), lambda stage, pct, msg: stages.append((stage, pct)))

    assert result.text == "结果"
    assert stages[0][0] == "transcribing"
    assert stages[-1] == ("transcribing", 100)
    # 结束后必须释放服务端 progress 会话
    assert len(deleted) == 1 and deleted[0].startswith(f"{MLX_ENDPOINT}/progress/")
