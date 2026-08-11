"""可插拔转录后端（mlx-api / openai-api）的测试。"""
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from modules import transcriber as transcriber_module
from modules.transcriber import (
    OpenAITranscriber,
    TranscriptionResult,
    WhisperApiTranscriber,
    describe_transcriber,
    get_transcriber,
)


class _FakeResponse:
    def __init__(self, *, json_data=None, text="", status_code=200, content_type="application/json"):
        self._json = json_data
        self.text = text
        self.status_code = status_code
        self.headers = {"content-type": content_type}

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError("error", request=None, response=self)


# ── 工厂与元数据 ──


def test_factory_defaults_to_mlx_backend():
    transcriber = get_transcriber({"api_url": "http://127.0.0.1:21567/transcribe"})
    assert isinstance(transcriber, WhisperApiTranscriber)


def test_factory_selects_openai_backend(monkeypatch):
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_API_KEY", "sk-test")
    transcriber = get_transcriber(
        {
            "backend": "openai-api",
            "openai": {"api_base": "https://api.groq.com/openai/v1", "model": "whisper-large-v3"},
        }
    )
    assert isinstance(transcriber, OpenAITranscriber)
    assert transcriber.api_key == "sk-test"
    assert transcriber._endpoint == "https://api.groq.com/openai/v1/audio/transcriptions"


def test_factory_rejects_unknown_backend():
    with pytest.raises(ValueError, match="未知转录后端"):
        get_transcriber({"backend": "made-up"})


def test_openai_backend_requires_api_base_and_model():
    with pytest.raises(ValueError, match="api_base"):
        get_transcriber({"backend": "openai-api", "openai": {"model": "whisper-1"}})
    with pytest.raises(ValueError, match="model"):
        get_transcriber({"backend": "openai-api", "openai": {"api_base": "https://x/v1"}})


def test_describe_transcriber_reports_backend_metadata():
    mlx = describe_transcriber({"backend": "mlx-api", "model": "mlx-whisper"})
    assert mlx["backend"] == "mlx-api"
    assert mlx["self_contained"] is False

    openai = describe_transcriber(
        {"backend": "openai-api", "openai": {"api_base": "https://x/v1", "model": "whisper-1"}}
    )
    assert openai["backend"] == "openai-api"
    assert openai["self_contained"] is False
    assert openai["model"] == "whisper-1"

    bundled = describe_transcriber(
        {
            "backend": "openai-api",
            "openai": {
                "api_base": "http://transcription:8000/v1",
                "model": "small",
                "self_contained": True,
            },
        }
    )
    assert bundled == {
        "backend": "openai-api",
        "engine": "faster-whisper",
        "device": "container-cpu",
        "model": "small",
        "self_contained": True,
    }


# ── OpenAI 后端行为 ──


def test_openai_transcribe_uses_cache(tmp_path):
    cache = tmp_path / "cached_raw.txt"
    cache.write_text("已缓存的转录文本", encoding="utf-8")
    transcriber = OpenAITranscriber(api_base="https://x/v1", model="whisper-1", api_key="k")

    result = transcriber.transcribe("/nonexistent/audio.mp3", cache_path=str(cache))

    assert result is not None
    assert result.text == "已缓存的转录文本"


def test_openai_transcribe_posts_and_caches(tmp_path, monkeypatch):
    audio = tmp_path / "clip.mp3"
    audio.write_bytes(b"fake-audio-bytes")
    cache = tmp_path / "out_raw.txt"

    captured = {}

    def fake_post(url, headers=None, data=None, files=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        captured["data"] = data
        return _FakeResponse(json_data={"text": "转录出来的正文"})

    monkeypatch.setattr(transcriber_module.httpx, "post", fake_post)

    transcriber = OpenAITranscriber(
        api_base="https://api.openai.com/v1", model="whisper-1", api_key="sk-x", language="zh"
    )
    result = transcriber.transcribe(str(audio), cache_path=str(cache))

    assert result is not None
    assert result.text == "转录出来的正文"
    assert captured["url"] == "https://api.openai.com/v1/audio/transcriptions"
    assert captured["headers"] == {"Authorization": "Bearer sk-x"}
    assert captured["data"]["model"] == "whisper-1"
    assert captured["data"]["language"] == "zh"
    # 结果写入缓存
    assert cache.read_text(encoding="utf-8") == "转录出来的正文"


def test_openai_transcribe_accepts_plain_text_response(tmp_path, monkeypatch):
    audio = tmp_path / "clip.mp3"
    audio.write_bytes(b"fake")

    def fake_post(url, headers=None, data=None, files=None, timeout=None):
        return _FakeResponse(text="纯文本转录", content_type="text/plain")

    monkeypatch.setattr(transcriber_module.httpx, "post", fake_post)
    transcriber = OpenAITranscriber(api_base="https://x/v1", model="whisper-1", api_key="k")

    result = transcriber.transcribe(str(audio))
    assert result is not None
    assert result.text == "纯文本转录"


def test_openai_transcribe_enforces_upload_limit(tmp_path):
    audio = tmp_path / "big.mp3"
    audio.write_bytes(b"x" * 2048)
    transcriber = OpenAITranscriber(
        api_base="https://x/v1", model="whisper-1", api_key="k", max_upload_bytes=1024
    )

    assert transcriber.transcribe(str(audio)) is None


def test_openai_transcribe_returns_none_on_http_error(tmp_path, monkeypatch):
    audio = tmp_path / "clip.mp3"
    audio.write_bytes(b"fake")

    def fake_post(url, headers=None, data=None, files=None, timeout=None):
        return _FakeResponse(status_code=401, json_data={"error": "unauthorized"})

    monkeypatch.setattr(transcriber_module.httpx, "post", fake_post)
    transcriber = OpenAITranscriber(api_base="https://x/v1", model="whisper-1", api_key="bad")

    assert transcriber.transcribe(str(audio)) is None
