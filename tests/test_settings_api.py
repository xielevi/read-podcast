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
from modules import config as config_module
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


def _mark_external(monkeypatch, *names):
    """把这些变量伪装成「进程启动前由 Compose/shell 注入」。

    真实部署里这份快照在 import 时就冻结了，测试无法用 setenv 模拟，
    因此直接替换快照本身。
    """
    monkeypatch.setattr(config_module, "EXTERNAL_ENV_KEYS", frozenset(names))


def test_env_managed_field_is_locked_and_rejected(temp_settings, monkeypatch):
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_API_URL", "http://host.docker.internal:21567/transcribe")
    _mark_external(monkeypatch, "READ_PODCAST_TRANSCRIPTION_API_URL")
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


def test_dotenv_field_is_not_locked(temp_settings, monkeypatch):
    """写在 .env 里的值不锁面板——否则用户改不了自己填过的字段。"""
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_API_URL", "http://127.0.0.1:21567/transcribe")
    _mark_external(monkeypatch)  # 没有任何外部注入，模拟 .env 加载后的状态
    settings.reload()
    with TestClient(app) as client:
        listed = client.get("/api/read-podcast/settings").json()

    assert _find_field(listed, "transcription.api_url")["locked"] is False


def test_externally_injected_secret_is_locked(temp_settings, monkeypatch):
    """Compose 注入的机密不归面板管，页面上只读。"""
    monkeypatch.setenv("REFINER_API_KEY", "sk-from-compose")
    _mark_external(monkeypatch, "REFINER_API_KEY")
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


def test_secret_file_never_overrides_external_injection(tmp_path, monkeypatch):
    """外部注入（Compose/shell）压过 secrets.env，部署方的决定不被面板改写。"""
    secrets_file = tmp_path / "secrets.env"
    secrets_file.write_text(
        "# comment\nREFINER_API_KEY=from-file\nREAD_PODCAST_WHISPER_API_TOKEN='quoted-token'\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("REFINER_API_KEY", "from-environment")
    monkeypatch.delenv("READ_PODCAST_WHISPER_API_TOKEN", raising=False)
    monkeypatch.setenv("READ_PODCAST_CONFIG", str(tmp_path / "config.yaml"))
    _mark_external(monkeypatch, "REFINER_API_KEY")

    fresh = config_module.Settings()
    assert os.environ["REFINER_API_KEY"] == "from-environment"
    assert "REFINER_API_KEY" not in fresh.MANAGED_SECRET_KEYS
    assert os.environ["READ_PODCAST_WHISPER_API_TOKEN"] == "quoted-token"
    assert "READ_PODCAST_WHISPER_API_TOKEN" in fresh.MANAGED_SECRET_KEYS


def test_empty_compose_variable_does_not_count_as_external(monkeypatch):
    """`${REFINER_API_KEY:-}` 注入的空串不算「部署方的决定」。

    docker-compose.yml 里的默认写法在用户没设该变量时会注入空串：键存在，
    但等于什么都没给。若算作外部注入，面板会被一个空值锁死，
    secrets.env 里的真实密钥也用不上（曾在容器里实测到这个回归）。
    """
    monkeypatch.setattr(os, "environ", {"EMPTY_VAR": "", "BLANK_VAR": "   ", "REAL_VAR": "v"})
    snapshot = frozenset(
        name for name, value in os.environ.items() if value.strip()
    )
    assert snapshot == {"REAL_VAR"}


def test_empty_external_secret_falls_through_to_secrets_file(tmp_path, monkeypatch):
    """Compose 注入空串时，secrets.env 的值应生效且面板保持可编辑。"""
    secrets_file = tmp_path / "secrets.env"
    secrets_file.write_text("REFINER_API_KEY=from-secrets-file\n", encoding="utf-8")
    monkeypatch.setenv("REFINER_API_KEY", "")  # Compose 的 ${VAR:-} 效果
    monkeypatch.setenv("READ_PODCAST_CONFIG", str(tmp_path / "config.yaml"))
    _mark_external(monkeypatch)  # 空串不进快照

    fresh = config_module.Settings()
    assert os.environ["REFINER_API_KEY"] == "from-secrets-file"
    assert "REFINER_API_KEY" in fresh.MANAGED_SECRET_KEYS
    assert user_settings._secret_is_external("REFINER_API_KEY") is False


def test_secret_file_overrides_dotenv_value(tmp_path, monkeypatch):
    """secrets.env 压过 .env：否则面板保存的新 Key 会被旧值静默盖掉。"""
    secrets_file = tmp_path / "secrets.env"
    secrets_file.write_text("REFINER_API_KEY=from-secrets-file\n", encoding="utf-8")
    # 模拟 .env 已被 load_dotenv 注入（因此在 os.environ 里，但不是外部注入）
    monkeypatch.setenv("REFINER_API_KEY", "from-dotenv")
    monkeypatch.setenv("READ_PODCAST_CONFIG", str(tmp_path / "config.yaml"))
    _mark_external(monkeypatch)

    fresh = config_module.Settings()
    assert os.environ["REFINER_API_KEY"] == "from-secrets-file"
    assert "REFINER_API_KEY" in fresh.MANAGED_SECRET_KEYS


def test_dotenv_secret_stays_editable_in_panel(temp_settings, monkeypatch):
    """.env 里的 Key 不锁面板，用户可以直接在网页上换掉它。"""
    monkeypatch.setenv("REFINER_API_KEY", "sk-from-dotenv")
    _mark_external(monkeypatch)
    with TestClient(app) as client:
        listed = client.get("/api/read-podcast/settings").json()
        saved = client.put(
            "/api/read-podcast/settings",
            json={"values": {}, "secrets": {"REFINER_API_KEY": "sk-from-webui"}},
        )

    field = _find_field(listed, "secret.REFINER_API_KEY")
    assert field["configured"] is True
    assert field["locked"] is False
    assert saved.status_code == 200
    assert os.environ["REFINER_API_KEY"] == "sk-from-webui"
    assert "sk-from-webui" in settings.SECRETS_PATH.read_text(encoding="utf-8")


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
