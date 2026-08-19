"""WebUI 个人配置面板：读写、机密隔离与环境变量接管。"""
import os
import stat
import sys
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from app.standalone import app
from modules import user_settings
from modules.config import settings

SECRET_ENVS = (
    "REFINER_API_KEY",
    "READ_PODCAST_WHISPER_API_TOKEN",
    "READ_PODCAST_TRANSCRIPTION_API_KEY",
)


@pytest.fixture
def temp_settings(tmp_path, monkeypatch):
    """把持久化配置与机密文件指向临时目录，测试结束后恢复真实配置。"""
    config_path = tmp_path / "config" / "config.yaml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "CONFIG_PATH", config_path)
    monkeypatch.setattr(settings, "SECRETS_PATH", config_path.parent / "secrets.env")
    monkeypatch.setattr(settings, "MANAGED_SECRET_KEYS", set())
    for name in SECRET_ENVS:
        monkeypatch.delenv(name, raising=False)
    settings.reload()
    try:
        yield config_path
    finally:
        monkeypatch.undo()
        settings.reload()


def _find_field(payload, key):
    for group in payload["groups"]:
        for field in group["fields"]:
            if field["key"] == key:
                return field
    raise AssertionError(f"字段 {key} 不在设置面板中")


def test_get_settings_never_returns_secret_values(temp_settings, monkeypatch):
    monkeypatch.setenv("REFINER_API_KEY", "sk-super-secret-value")
    with TestClient(app) as client:
        response = client.get("/api/read-podcast/settings")
    assert response.status_code == 200
    assert "sk-super-secret-value" not in response.text

    field = _find_field(response.json(), "secret.REFINER_API_KEY")
    assert field["configured"] is True
    assert "value" not in field


def test_put_settings_persists_config_and_hot_reloads(temp_settings):
    with TestClient(app) as client:
        response = client.put(
            "/api/read-podcast/settings",
            json={
                "values": {
                    "refiner.api_base": "https://api.deepseek.com/v1",
                    "refiner.model": "deepseek-chat",
                    "refiner.temperature": "0.25",
                },
                "secrets": {},
            },
        )
    assert response.status_code == 200

    stored = yaml.safe_load(temp_settings.read_text(encoding="utf-8"))
    section = stored.get("read-podcast", stored)
    assert section["refiner"]["api_base"] == "https://api.deepseek.com/v1"
    assert section["refiner"]["temperature"] == 0.25
    # 未提交的字段保持内置默认值，不被写入覆盖文件。
    assert "max_tokens" not in section["refiner"]

    # 进程内配置立即生效，无需重启。
    assert settings.REFINER_CONFIG["model"] == "deepseek-chat"
    assert settings.REFINER_CONFIG["max_tokens"] == 65536


def test_put_settings_writes_secret_file_with_owner_only_permission(temp_settings):
    with TestClient(app) as client:
        response = client.put(
            "/api/read-podcast/settings",
            json={"values": {}, "secrets": {"REFINER_API_KEY": "sk-written-by-webui"}},
        )
    assert response.status_code == 200
    assert "sk-written-by-webui" not in response.text

    secrets_path = settings.SECRETS_PATH
    assert secrets_path.exists()
    assert stat.S_IMODE(secrets_path.stat().st_mode) == 0o600
    assert "REFINER_API_KEY=sk-written-by-webui" in secrets_path.read_text(encoding="utf-8")
    # 同步注入当前进程，AI 功能立即可用。
    assert os.environ["REFINER_API_KEY"] == "sk-written-by-webui"
    assert "REFINER_API_KEY" in settings.MANAGED_SECRET_KEYS


def test_empty_value_removes_override_and_falls_back_to_default(temp_settings):
    with TestClient(app) as client:
        client.put(
            "/api/read-podcast/settings",
            json={"values": {"paths.download_dir": str(temp_settings.parent / "audio")}, "secrets": {}},
        )
        response = client.put(
            "/api/read-podcast/settings",
            json={"values": {"paths.download_dir": ""}, "secrets": {}},
        )
    assert response.status_code == 200

    stored = yaml.safe_load(temp_settings.read_text(encoding="utf-8"))
    section = stored.get("read-podcast", stored)
    assert "download_dir" not in section.get("paths", {})
    assert settings.DOWNLOAD_DIR == settings.PROJECT_ROOT / "workspace" / "downloads"


def test_clearing_secret_removes_it_everywhere(temp_settings):
    with TestClient(app) as client:
        client.put(
            "/api/read-podcast/settings",
            json={"values": {}, "secrets": {"READ_PODCAST_TRANSCRIPTION_API_KEY": "sk-tmp"}},
        )
        response = client.put(
            "/api/read-podcast/settings",
            json={"values": {}, "secrets": {"READ_PODCAST_TRANSCRIPTION_API_KEY": ""}},
        )
    assert response.status_code == 200
    assert "READ_PODCAST_TRANSCRIPTION_API_KEY" not in os.environ
    assert "sk-tmp" not in settings.SECRETS_PATH.read_text(encoding="utf-8")
    field = _find_field(response.json(), "secret.READ_PODCAST_TRANSCRIPTION_API_KEY")
    assert field["configured"] is False


def test_env_managed_field_is_locked_and_rejected(temp_settings, monkeypatch):
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_API_URL", "http://host.docker.internal:21567/transcribe")
    settings.reload()
    with TestClient(app) as client:
        listed = client.get("/api/read-podcast/settings").json()
        rejected = client.put(
            "/api/read-podcast/settings",
            json={"values": {"transcription.api_url": "http://127.0.0.1:21567/transcribe"}, "secrets": {}},
        )

    field = _find_field(listed, "transcription.api_url")
    assert field["locked"] is True
    assert "READ_PODCAST_TRANSCRIPTION_API_URL" in field["locked_reason"]
    assert rejected.status_code == 400
    assert "环境变量" in rejected.json()["detail"]


def test_externally_injected_secret_is_locked(temp_settings, monkeypatch):
    """Compose/.env 注入的机密不归面板管，页面上只读。"""
    monkeypatch.setenv("REFINER_API_KEY", "sk-from-compose")
    with TestClient(app) as client:
        listed = client.get("/api/read-podcast/settings").json()
        rejected = client.put(
            "/api/read-podcast/settings",
            json={"values": {}, "secrets": {"REFINER_API_KEY": "sk-from-webui"}},
        )

    field = _find_field(listed, "secret.REFINER_API_KEY")
    assert field["locked"] is True
    assert rejected.status_code == 400
    assert os.environ["REFINER_API_KEY"] == "sk-from-compose"
    assert not settings.SECRETS_PATH.exists()


@pytest.mark.parametrize(
    "payload",
    [
        {"values": {"refiner.api_base": "ftp://example.com/v1"}, "secrets": {}},
        {"values": {"refiner.temperature": "9"}, "secrets": {}},
        {"values": {"refiner.max_tokens": "abc"}, "secrets": {}},
        {"values": {"transcription.backend": "whatever"}, "secrets": {}},
        {"values": {"podcasts": "[]"}, "secrets": {}},
        {"values": {}, "secrets": {"AWS_SECRET_ACCESS_KEY": "x"}},
    ],
)
def test_invalid_payloads_are_rejected(temp_settings, payload):
    with TestClient(app) as client:
        response = client.put("/api/read-podcast/settings", json=payload)
    assert response.status_code == 400
    assert not temp_settings.exists() or not yaml.safe_load(
        temp_settings.read_text(encoding="utf-8")
    )


def test_secret_file_is_loaded_but_never_overrides_real_environment(tmp_path, monkeypatch):
    secrets_file = tmp_path / "secrets.env"
    secrets_file.write_text(
        "# comment\nREFINER_API_KEY=from-file\nREAD_PODCAST_WHISPER_API_TOKEN='quoted-token'\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("REFINER_API_KEY", "from-environment")
    monkeypatch.delenv("READ_PODCAST_WHISPER_API_TOKEN", raising=False)
    monkeypatch.setenv("READ_PODCAST_CONFIG", str(tmp_path / "config.yaml"))

    from modules.config import Settings

    fresh = Settings()
    assert os.environ["REFINER_API_KEY"] == "from-environment"
    assert "REFINER_API_KEY" not in fresh.MANAGED_SECRET_KEYS
    assert os.environ["READ_PODCAST_WHISPER_API_TOKEN"] == "quoted-token"
    assert "READ_PODCAST_WHISPER_API_TOKEN" in fresh.MANAGED_SECRET_KEYS


def test_probe_endpoint_reports_missing_configuration(temp_settings, monkeypatch):
    monkeypatch.setattr(settings, "REFINER_CONFIG", {"api_base": "", "model": ""})
    with TestClient(app) as client:
        response = client.post("/api/read-podcast/settings/test", json={"target": "refiner"})
    assert response.status_code == 502
    assert "AI 服务地址" in response.json()["detail"]


def test_probe_failures_do_not_leak_service_address():
    assert user_settings._redact("网络错误: https://api.example.com/v1/chat 超时") == (
        "网络错误: [服务地址] 超时"
    )


def test_basic_auth_protects_settings_endpoints(temp_settings, monkeypatch):
    """开启 Basic Auth 后，配置面板与保存接口同样受保护。"""
    monkeypatch.setenv("READ_PODCAST_BASIC_AUTH_USERNAME", "reader")
    monkeypatch.setenv("READ_PODCAST_BASIC_AUTH_PASSWORD", "secret")
    with TestClient(app) as client:
        anonymous_get = client.get("/api/read-podcast/settings")
        anonymous_put = client.put(
            "/api/read-podcast/settings",
            json={"values": {}, "secrets": {"REFINER_API_KEY": "sk-anonymous"}},
        )
        authorized = client.get("/api/read-podcast/settings", auth=("reader", "secret"))

    assert anonymous_get.status_code == 401
    assert anonymous_put.status_code == 401
    assert authorized.status_code == 200
    assert not settings.SECRETS_PATH.exists()
