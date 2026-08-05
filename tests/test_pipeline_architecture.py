import asyncio
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from fastapi.testclient import TestClient

from app import tasks as tasks_module
from app.models.task import TaskStatus
from modules.downloader import Downloader
from modules.transcriber import WhisperApiTranscriber
from modules.utils import StateManager
from scripts import mlx_backend


class FakeDownloadResponse:
    def __init__(self, payload: bytes, *, url: str, content_type: str):
        self.payload = payload
        self.url = url
        self.headers = {"Content-Type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size: int):
        for start in range(0, len(self.payload), chunk_size):
            yield self.payload[start : start + chunk_size]


class FakeHttpResponse:
    def __init__(self, status_code=200, body=None):
        self.status_code = status_code
        self._body = body or {"text": "共享路径转录", "language": "zh"}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._body


def test_downloader_preserves_source_audio_format(tmp_path, monkeypatch):
    payload = b"m4a-data" * 20_000
    response = FakeDownloadResponse(
        payload,
        url="https://cdn.example.com/episode.m4a",
        content_type="audio/mp4",
    )
    monkeypatch.setattr("modules.downloader.safe_get", lambda *_args, **_kwargs: response)
    yt_dlp = Mock(side_effect=AssertionError("direct enclosure should not invoke yt-dlp"))
    monkeypatch.setattr("modules.downloader.subprocess.run", yt_dlp)

    downloaded = Path(Downloader(tmp_path).download_audio("https://feed/episode", "episode"))

    assert downloaded.name == "episode.m4a"
    assert downloaded.read_bytes() == payload
    assert not list(tmp_path.glob("*.part"))
    yt_dlp.assert_not_called()


def test_transcriber_uses_shared_path_and_atomically_caches(tmp_path, monkeypatch):
    shared_root = tmp_path / "workspace"
    audio = shared_root / "show" / "downloads" / "episode.m4a"
    audio.parent.mkdir(parents=True)
    audio.write_bytes(b"audio")
    cache = shared_root / "show" / "transcripts" / "episode_raw.txt"
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return FakeHttpResponse()

    monkeypatch.setattr("modules.transcriber.httpx.post", fake_post)
    transcriber = WhisperApiTranscriber(
        api_url="http://mlx:21567/transcribe",
        shared_audio_root=str(shared_root),
    )

    result = transcriber.transcribe(str(audio), cache_path=str(cache))

    assert result.text == "共享路径转录"
    assert calls[0][0] == "http://mlx:21567/transcribe-path"
    assert calls[0][1]["json"] == {"path": "show/downloads/episode.m4a"}
    assert "files" not in calls[0][1]
    assert cache.read_text(encoding="utf-8") == "共享路径转录"
    assert not cache.with_suffix(".txt.part").exists()


def test_transcriber_falls_back_to_upload_on_shared_path_403(tmp_path, monkeypatch):
    shared_root = tmp_path / "workspace"
    audio = shared_root / "show" / "downloads" / "episode.m4a"
    audio.parent.mkdir(parents=True)
    audio.write_bytes(b"audio")
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return FakeHttpResponse(status_code=403) if url.endswith("transcribe-path") else FakeHttpResponse()

    monkeypatch.setattr("modules.transcriber.httpx.post", fake_post)
    transcriber = WhisperApiTranscriber(
        api_url="http://mlx:21567/transcribe",
        shared_audio_root=str(shared_root),
    )

    result = transcriber.transcribe(str(audio))

    assert result.text == "共享路径转录"
    assert [url for url, _ in calls] == [
        "http://mlx:21567/transcribe-path",
        "http://mlx:21567/transcribe",
    ]
    assert "files" in calls[1][1]


def test_transcriber_reports_native_chunk_progress(monkeypatch):
    callbacks = []
    deleted = []

    def request(request_id):
        assert request_id
        time.sleep(1.05)
        return FakeHttpResponse()

    monkeypatch.setattr(
        "modules.transcriber.httpx.get",
        lambda *_args, **_kwargs: FakeHttpResponse(
            body={"progress": 50, "completed_chunks": 2, "total_chunks": 4}
        ),
    )
    monkeypatch.setattr(
        "modules.transcriber.httpx.delete",
        lambda url, **_kwargs: deleted.append(url),
    )
    transcriber = WhisperApiTranscriber(api_url="http://mlx:21567/transcribe")

    response = transcriber._request_with_progress(request, lambda *args: callbacks.append(args))

    assert response.status_code == 200
    assert callbacks == [("transcribing", 52, "Whisper 分片 2/4（50%）")]
    assert deleted and "/progress/" in deleted[0]


def test_native_backend_shared_path_is_allowlisted(tmp_path, monkeypatch):
    audio = tmp_path / "uploads" / "sample.wav"
    audio.parent.mkdir()
    audio.write_bytes(b"fake-audio")
    monkeypatch.setattr(mlx_backend, "SHARED_AUDIO_ROOT", tmp_path)
    monkeypatch.setattr(mlx_backend, "API_TOKEN", "")
    monkeypatch.setattr(mlx_backend, "CHUNK_DURATION", 0)
    fake_mlx = SimpleNamespace(
        transcribe=lambda *_args, **_kwargs: {
            "text": "path transcription",
            "language": "en",
            "segments": [{"text": "path transcription", "avg_logprob": float("nan")}],
        }
    )
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake_mlx)
    monkeypatch.setattr(mlx_backend, "MODEL_IDLE_TTL_SECONDS", 0)
    release_model = Mock()
    monkeypatch.setattr(mlx_backend, "_release_mlx_model", release_model)

    with TestClient(mlx_backend.app) as client:
        accepted = client.post("/transcribe-path", json={"path": "uploads/sample.wav"})
        denied = client.post("/transcribe-path", json={"path": "../outside.wav"})
        missing = client.post("/transcribe-path", json={"path": "uploads/missing.wav"})
        mlx_backend._set_request_progress(
            "test-request",
            progress=50,
            completed_chunks=2,
            total_chunks=4,
        )
        progress = client.get("/progress/test-request")
        cleared = client.delete("/progress/test-request")
        missing_progress = client.get("/progress/test-request")

    assert accepted.status_code == 200
    assert accepted.json()["text"] == "path transcription"
    assert accepted.json()["segments"][0]["avg_logprob"] is None
    assert denied.status_code == 403
    assert missing.status_code == 404
    assert progress.json() == {
        "status": "running",
        "progress": 50,
        "completed_chunks": 2,
        "total_chunks": 4,
    }
    assert cleared.status_code == 200
    assert missing_progress.status_code == 404
    release_model.assert_called_once_with()


def test_web_task_marks_missing_output_as_failed(monkeypatch):
    class FakePipeline:
        def prepare_episode(self, *_args, **_kwargs):
            return SimpleNamespace(output_path=None)

        def transcribe(self, work, *_args, **_kwargs):
            return work

        def refine(self, work, *_args, **_kwargs):
            return work

        def finalize(self, work):
            return work

    updates = []

    async def record_update(task_id, **kwargs):
        updates.append((task_id, kwargs))

    monkeypatch.setattr(tasks_module, "PodcastPipeline", FakePipeline)
    monkeypatch.setattr(tasks_module, "update_task", record_update)
    monkeypatch.setattr(tasks_module, "get_task", AsyncMock(return_value=None))
    monkeypatch.setattr(tasks_module.notifier, "push", AsyncMock())

    asyncio.run(tasks_module.run_pipeline("task-1", "show", "episode"))

    assert any(update.get("status") == TaskStatus.FAILED for _, update in updates)
    assert not any(update.get("status") == TaskStatus.SUCCESS for _, update in updates)


def test_state_manager_merges_updates_from_multiple_pipeline_instances(tmp_path):
    state_file = tmp_path / "state.json"
    first = StateManager(state_file)
    second = StateManager(state_file)

    first.mark_processed("episode-1")
    second.mark_processed("episode-2")

    reloaded = StateManager(state_file)
    assert reloaded.processed_ids == {"episode-1", "episode-2"}
    assert not state_file.with_suffix(".json.part").exists()
