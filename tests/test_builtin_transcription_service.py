"""Bundled Faster-Whisper companion service contract tests."""
from types import SimpleNamespace

from fastapi.testclient import TestClient

from services.builtin_transcription import app as service


class _Segment:
    def __init__(self, start, end, text):
        self.start = start
        self.end = end
        self.text = text


class _FakeModel:
    def transcribe(self, path, **kwargs):
        assert path
        assert kwargs["beam_size"] >= 1
        return iter([_Segment(0, 1.2, "你好"), _Segment(1.2, 2.4, "世界")]), SimpleNamespace(
            language="zh",
            duration=2.4,
        )


def test_health_does_not_preload_model(monkeypatch):
    monkeypatch.setattr(service, "_model", None)
    with TestClient(service.app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["engine"] == "faster-whisper"
    assert response.json()["model_loaded"] is False


def test_openai_compatible_transcription_formats(monkeypatch):
    monkeypatch.setattr(service, "_model", _FakeModel())
    monkeypatch.setattr(service, "API_TOKEN", "")
    with TestClient(service.app) as client:
        simple = client.post(
            "/v1/audio/transcriptions",
            data={"model": "whisper-1", "response_format": "json"},
            files={"file": ("clip.mp3", b"fake-audio", "audio/mpeg")},
        )
        verbose = client.post(
            "/v1/audio/transcriptions",
            data={"model": service.MODEL_ID, "response_format": "verbose_json"},
            files={"file": ("clip.mp3", b"fake-audio", "audio/mpeg")},
        )
        text = client.post(
            "/v1/audio/transcriptions",
            data={"model": "whisper-1", "response_format": "text"},
            files={"file": ("clip.mp3", b"fake-audio", "audio/mpeg")},
        )

    assert simple.json() == {"text": "你好世界"}
    assert verbose.json()["language"] == "zh"
    assert len(verbose.json()["segments"]) == 2
    assert text.text == "你好世界"


def test_transcription_token_and_upload_limit(monkeypatch):
    monkeypatch.setattr(service, "_model", _FakeModel())
    monkeypatch.setattr(service, "API_TOKEN", "secret")
    monkeypatch.setattr(service, "MAX_UPLOAD_BYTES", 4)
    with TestClient(service.app) as client:
        anonymous = client.post(
            "/v1/audio/transcriptions",
            data={"model": "whisper-1"},
            files={"file": ("clip.mp3", b"1234", "audio/mpeg")},
        )
        too_large = client.post(
            "/v1/audio/transcriptions",
            headers={"Authorization": "Bearer secret"},
            data={"model": "whisper-1"},
            files={"file": ("clip.mp3", b"12345", "audio/mpeg")},
        )

    assert anonymous.status_code == 403
    assert too_large.status_code == 413
