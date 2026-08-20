import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
import yaml
from fastapi.testclient import TestClient

from app import router as router_module
from app.models.task import Task
from app.standalone import app
from modules.config import Settings, settings
from modules.transcriber import WhisperApiTranscriber, describe_transcriber, get_transcriber
from scripts import mlx_backend
from scripts import podcast_pipeline


@pytest.fixture(autouse=True)
def clear_web_access_environment(monkeypatch):
    for prefix in ("READ_PODCAST", "PODCAST2MD"):
        monkeypatch.delenv(f"{prefix}_BASIC_AUTH_USERNAME", raising=False)
        monkeypatch.delenv(f"{prefix}_BASIC_AUTH_PASSWORD", raising=False)
        monkeypatch.delenv(f"{prefix}_TRANSCRIPTION_API_URL", raising=False)
        monkeypatch.delenv(f"{prefix}_TRANSCRIPTION_SHARED_AUDIO_ROOT", raising=False)
        monkeypatch.delenv(f"{prefix}_OUTPUT_DIR", raising=False)
        monkeypatch.delenv(f"{prefix}_WHISPER_API_TOKEN", raising=False)
    monkeypatch.setattr(mlx_backend, "CHUNK_DURATION", 0)


def test_settings_accepts_namespaced_config(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump({"read-podcast": {"transcription": {"api_url": "http://mlx/transcribe"}}}),
        encoding="utf-8",
    )

    loaded = Settings(config_path)

    assert loaded.TRANSCRIPTION_CONFIG["api_url"] == "http://mlx/transcribe"


def test_settings_accepts_legacy_namespaced_config(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump({"podcast2md": {"transcription": {"api_url": "http://mlx/transcribe"}}}),
        encoding="utf-8",
    )

    loaded = Settings(config_path)

    assert loaded.TRANSCRIPTION_CONFIG["api_url"] == "http://mlx/transcribe"


def test_settings_accepts_standalone_config(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump({"transcription": {"api_url": "http://mlx/transcribe"}}),
        encoding="utf-8",
    )

    loaded = Settings(config_path)

    assert loaded.TRANSCRIPTION_CONFIG["api_url"] == "http://mlx/transcribe"


def test_transcription_environment_overrides_persisted_deployment_mode(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "transcription:\n  api_url: http://host.docker.internal:21567/transcribe\n"
        "  shared_audio_root: /app/workspace\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_API_URL", "http://127.0.0.1:21567/transcribe")
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_SHARED_AUDIO_ROOT", "")

    loaded = Settings(config_path)

    assert loaded.TRANSCRIPTION_CONFIG["api_url"] == "http://127.0.0.1:21567/transcribe"
    assert loaded.TRANSCRIPTION_CONFIG["shared_audio_root"] == ""


def test_self_contained_transcription_environment_builds_openai_config(tmp_path, monkeypatch):
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_BACKEND", "openai-api")
    monkeypatch.setenv(
        "READ_PODCAST_TRANSCRIPTION_OPENAI_API_BASE",
        "http://transcription:8000/v1",
    )
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_OPENAI_MODEL", "small")
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_OPENAI_SELF_CONTAINED", "true")

    loaded = Settings(tmp_path / "missing.yaml")

    assert loaded.TRANSCRIPTION_CONFIG["backend"] == "openai-api"
    openai_config = loaded.TRANSCRIPTION_CONFIG["openai"]
    assert openai_config["api_base"] == "http://transcription:8000/v1"
    assert openai_config["model"] == "small"
    assert openai_config["self_contained"] is True


def test_settings_deep_merges_user_overrides_with_defaults(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "runtime": {"download_concurrency": 4},
                "refiner": {"model": "local-override"},
                "podcasts": [{"name": "Example", "rss_url": "https://example.com/feed"}],
            }
        ),
        encoding="utf-8",
    )

    loaded = Settings(config_path)

    assert loaded.RUNTIME_CONFIG["download_concurrency"] == 4
    assert loaded.RUNTIME_CONFIG["refine_concurrency"] == 2
    assert loaded.REFINER_CONFIG["model"] == "local-override"
    assert loaded.REFINER_CONFIG["api_base"] == "https://api.your-provider.com/v1"
    assert loaded.MLX_CONFIG["model_idle_seconds"] == 300
    assert loaded.PODCASTS == [{"name": "Example", "rss_url": "https://example.com/feed"}]


def test_settings_merges_prompt_templates_by_name(tmp_path: Path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "prompt_templates": [
                    {"name": "default", "description": "本地覆盖", "content": "local"},
                    {"name": "local-only", "description": "仅本地", "content": "extra"},
                ]
            },
            allow_unicode=True,
        ),
        encoding="utf-8",
    )
    monkeypatch.delenv("READ_PODCAST_OUTPUT_DIR", raising=False)

    loaded = Settings(config_path)
    templates = {item["name"]: item for item in loaded.PROMPT_TEMPLATES}

    assert templates["default"]["content"] == "local"
    assert {"田野调查访谈整理", "讲座内容整理", "会议内容整理"} <= templates.keys()
    assert templates["local-only"]["content"] == "extra"


def test_settings_uses_compose_output_dir(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("READ_PODCAST_OUTPUT_DIR", str(tmp_path / "output"))

    loaded = Settings(tmp_path / "missing.yaml")

    assert loaded.OBSIDIAN_MARKDOWN_DIR == tmp_path / "output"


def test_standalone_health_and_frontend():
    with TestClient(app) as client:
        health = client.get("/api/read-podcast/health").json()
        transcription = client.get("/api/read-podcast/transcription/status").json()
        response = client.get("/")
        script = client.get("/app.js")
        stylesheet = client.get("/app.css")

    assert health == {"status": "healthy", "service": "read-podcast"}
    assert transcription["backend"] == "mlx-api"
    assert transcription["engine"] == "mlx-whisper"
    assert transcription["self_contained"] is False
    assert response.status_code == 200
    assert "Read Podcast" in response.text
    assert script.status_code == 200
    assert stylesheet.status_code == 200
    assert "@media (min-width: 1440px)" in stylesheet.text
    assert ".history-list { max-height: clamp(260px, 38vh, 420px); }" in stylesheet.text
    assert 'id="episode-list"' in response.text
    assert 'id="episode-pagination"' in response.text
    assert 'id="episode-inspector"' in response.text
    assert 'id="reader-progress-range"' in response.text
    assert 'id="episode-summary-drawer"' in response.text
    assert 'id="google-docs-login"' in response.text
    assert 'id="feishu-docs-login"' in response.text
    assert 'id="integration-drawer"' in response.text
    assert "function openIntegration(provider)" in script.text
    assert "window.READ_PODCAST_BASE_PATH" in response.text
    assert 'href="app.css"' not in response.text
    assert '<script src="app.js"></script>' not in response.text
    assert "var APP_BASE_PATH = (function detectBasePath()" in script.text
    assert "function appUrl(path)" in script.text
    assert "var SAFE_LINK =" in script.text
    assert "fetch('/api/read-podcast" not in script.text
    assert "xhr.open('POST', '/api/read-podcast" not in script.text


def test_standalone_keeps_legacy_api_health_alias():
    with TestClient(app) as client:
        response = client.get("/api/podcast2md/health")

    assert response.status_code == 200
    assert response.json() == {"status": "healthy", "service": "read-podcast"}


def test_standalone_supports_configured_base_path(monkeypatch):
    monkeypatch.setitem(settings.WEB_CONFIG, "base_path", "/podcast/")

    with TestClient(app) as client:
        frontend = client.get("/podcast")
        script = client.get("/podcast/app.js")
        stylesheet = client.get("/podcast/app.css")
        health = client.get("/podcast/api/read-podcast/health")

    assert frontend.status_code == 200
    assert script.status_code == 200
    assert stylesheet.status_code == 200
    assert health.status_code == 200
    assert health.json() == {"status": "healthy", "service": "read-podcast"}


def test_optional_basic_auth_protects_webui_and_api(monkeypatch):
    monkeypatch.setenv("READ_PODCAST_BASIC_AUTH_USERNAME", "reader")
    monkeypatch.setenv("READ_PODCAST_BASIC_AUTH_PASSWORD", "secret")

    with TestClient(app) as client:
        anonymous = client.get("/")
        invalid = client.get("/api/read-podcast/transcription/status", auth=("reader", "wrong"))
        frontend = client.get("/", auth=("reader", "secret"))
        api = client.get("/api/read-podcast/transcription/status", auth=("reader", "secret"))
        health = client.get("/api/read-podcast/health")

    assert anonymous.status_code == 401
    assert anonymous.headers["www-authenticate"] == 'Basic realm="Read Podcast", charset="UTF-8"'
    assert invalid.status_code == 401
    assert frontend.status_code == 200
    assert api.status_code == 200
    assert health.status_code == 200


def test_partial_basic_auth_configuration_fails_fast(monkeypatch):
    monkeypatch.setenv("READ_PODCAST_BASIC_AUTH_USERNAME", "reader")

    with pytest.raises(RuntimeError, match="must be configured together"):
        with TestClient(app):
            pass


def test_transcriber_uses_public_api_url(monkeypatch):
    monkeypatch.setenv("READ_PODCAST_WHISPER_API_URL", "http://ignored/transcribe")
    monkeypatch.setenv("READ_PODCAST_WHISPER_API_TOKEN", "secret")

    transcriber = get_transcriber({"api_url": "http://mlx-host:21567", "timeout": 60})

    assert isinstance(transcriber, WhisperApiTranscriber)
    assert transcriber.api_url == "http://mlx-host:21567/transcribe"
    assert transcriber.timeout == 60
    assert transcriber.api_token == "secret"


def test_transcriber_status_hides_api_url():
    status = describe_transcriber(
        {"api_url": "http://private-host:21567/transcribe", "model": "large-v3-turbo"}
    )

    assert status == {
        "backend": "mlx-api",
        "engine": "mlx-whisper",
        "device": "native-macos",
        "model": "large-v3-turbo",
        "self_contained": False,
    }
    assert "private-host" not in str(status)


def test_native_mlx_backend_transcribes_uploaded_audio(monkeypatch):
    fake_mlx = SimpleNamespace(
        transcribe=lambda *_args, **_kwargs: {
            "text": "测试转录",
            "language": "zh",
            "segments": [],
        }
    )
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake_mlx)
    monkeypatch.setattr(mlx_backend, "MODEL_IDLE_TTL_SECONDS", 0)
    release_model = Mock()
    monkeypatch.setattr(mlx_backend, "_release_mlx_model", release_model)

    with TestClient(mlx_backend.app) as client:
        health = client.get("/health")
        response = client.post(
            "/transcribe",
            files={"file": ("sample.wav", b"fake-audio", "audio/wav")},
        )

    assert health.status_code == 200
    assert health.json()["engine"] == "mlx-whisper"
    assert response.status_code == 200
    assert response.json()["text"] == "测试转录"
    release_model.assert_called_once_with()


def test_native_mlx_backend_requires_configured_token(monkeypatch):
    monkeypatch.setattr(mlx_backend, "API_TOKEN", "secret")
    fake_mlx = SimpleNamespace(
        transcribe=lambda *_args, **_kwargs: {
            "text": "authenticated",
            "language": "en",
            "segments": [],
        }
    )
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake_mlx)
    monkeypatch.setattr(mlx_backend, "MODEL_IDLE_TTL_SECONDS", 0)
    release_model = Mock()
    monkeypatch.setattr(mlx_backend, "_release_mlx_model", release_model)

    with TestClient(mlx_backend.app) as client:
        denied = client.post(
            "/transcribe",
            files={"file": ("sample.wav", b"fake-audio", "audio/wav")},
        )
        accepted = client.post(
            "/transcribe",
            headers={"Authorization": "Bearer secret"},
            files={"file": ("sample.wav", b"fake-audio", "audio/wav")},
        )

    assert denied.status_code == 403
    assert accepted.status_code == 200
    assert accepted.json()["text"] == "authenticated"
    release_model.assert_called_once_with()


def test_native_mlx_backend_rejects_unconfigured_model(monkeypatch):
    monkeypatch.setattr(mlx_backend, "API_TOKEN", "")
    with TestClient(mlx_backend.app) as client:
        response = client.post(
            "/transcribe",
            data={"model": "untrusted/model"},
            files={"file": ("sample.wav", b"fake-audio", "audio/wav")},
        )
    assert response.status_code == 400


def test_native_mlx_backend_limits_upload_size(monkeypatch):
    monkeypatch.setattr(mlx_backend, "API_TOKEN", "")
    monkeypatch.setattr(mlx_backend, "MAX_UPLOAD_BYTES", 4)
    with TestClient(mlx_backend.app) as client:
        response = client.post(
            "/transcribe",
            files={"file": ("sample.wav", b"12345", "audio/wav")},
        )
    assert response.status_code == 413


def test_native_mlx_backend_keeps_model_warm_until_idle_ttl(monkeypatch):
    calls = []

    def fake_transcribe(*_args, **_kwargs):
        calls.append(True)
        return {"text": "warm transcription", "language": "en", "segments": []}

    monkeypatch.setattr(mlx_backend, "API_TOKEN", "")
    monkeypatch.setattr(mlx_backend, "MODEL_IDLE_TTL_SECONDS", 300)
    monkeypatch.setitem(sys.modules, "mlx_whisper", SimpleNamespace(transcribe=fake_transcribe))
    release_model = Mock()
    monkeypatch.setattr(mlx_backend, "_release_mlx_model", release_model)

    with TestClient(mlx_backend.app) as client:
        first = client.post(
            "/transcribe",
            files={"file": ("first.wav", b"fake-audio", "audio/wav")},
        )
        second = client.post(
            "/transcribe",
            files={"file": ("second.wav", b"fake-audio", "audio/wav")},
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert len(calls) == 2
    release_model.assert_not_called()


def test_pipeline_exits_cleanly_when_environment_is_missing(monkeypatch):
    monkeypatch.setattr(podcast_pipeline, "check_environment", lambda: False)

    with pytest.raises(SystemExit) as exc:
        podcast_pipeline.main()

    assert exc.value.code == 1


def test_task_content_returns_utf8_text_without_absolute_path(tmp_path: Path, monkeypatch):
    output_file = tmp_path / "episode.md"
    output_file.write_text("# 一期节目\n\n正文", encoding="utf-8")
    task = Task(
        id="task-success",
        podcast_name="测试播客",
        episode_title="一期节目",
        output_path=str(output_file),
    )
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=task))

    with TestClient(app) as client:
        response = client.get("/api/read-podcast/tasks/task-success/content")

    assert response.status_code == 200
    assert response.json() == {
        "task_id": "task-success",
        "title": "一期节目",
        "filename": "episode.md",
        "content": "# 一期节目\n\n正文",
    }
    assert str(output_file) not in response.text


def test_task_status_does_not_expose_local_paths(tmp_path: Path, monkeypatch):
    output_file = tmp_path / "episode.md"
    task = Task(
        id="task-status",
        podcast_name="测试播客",
        episode_title="一期节目",
        output_path=str(output_file),
    )
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=task))

    with TestClient(app) as client:
        response = client.get("/api/read-podcast/tasks/task-status")

    assert response.status_code == 200
    assert response.json()["id"] == "task-status"
    assert "output_path" not in response.json()
    assert "log_path" not in response.json()


def test_upload_rejects_oversize_audio_without_partial_file(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(router_module, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(router_module, "MAX_UPLOAD_BYTES", 4)

    with TestClient(app) as client:
        response = client.post(
            "/api/read-podcast/upload/audio",
            files={"file": ("sample.wav", b"too-large", "audio/wav")},
        )

    assert response.status_code == 413
    assert not list(tmp_path.iterdir())


def test_task_content_uses_filename_when_episode_title_is_empty(tmp_path: Path, monkeypatch):
    output_file = tmp_path / "fallback.markdown"
    output_file.write_text("正文", encoding="utf-8")
    task = Task(
        id="task-fallback",
        podcast_name="测试播客",
        episode_title="",
        output_path=str(output_file),
    )
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=task))

    with TestClient(app) as client:
        response = client.get("/api/read-podcast/tasks/task-fallback/content")

    assert response.status_code == 200
    assert response.json()["title"] == "fallback.markdown"


def test_task_content_returns_404_when_task_is_missing(monkeypatch):
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=None))

    with TestClient(app) as client:
        response = client.get("/api/read-podcast/tasks/missing-task/content")

    assert response.status_code == 404


def test_task_content_returns_404_when_output_is_missing(tmp_path: Path, monkeypatch):
    tasks = [
        Task(
            id="missing-path",
            podcast_name="测试播客",
            episode_title="缺少路径",
            output_path=None,
        ),
        Task(
            id="missing-file",
            podcast_name="测试播客",
            episode_title="缺少文件",
            output_path=str(tmp_path / "missing.md"),
        ),
    ]
    monkeypatch.setattr(router_module, "get_task", AsyncMock(side_effect=tasks))

    with TestClient(app) as client:
        missing_path = client.get("/api/read-podcast/tasks/missing-path/content")
        missing_file = client.get("/api/read-podcast/tasks/missing-file/content")

    assert missing_path.status_code == 404
    assert missing_file.status_code == 404


def test_task_content_rejects_non_text_output(tmp_path: Path, monkeypatch):
    output_file = tmp_path / "episode.pdf"
    output_file.write_bytes(b"not a text output")
    task = Task(
        id="task-pdf",
        podcast_name="测试播客",
        episode_title="PDF 输出",
        output_path=str(output_file),
    )
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=task))

    with TestClient(app) as client:
        response = client.get("/api/read-podcast/tasks/task-pdf/content")

    assert response.status_code == 415
