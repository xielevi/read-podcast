from modules.config import Settings
from modules.runtime_paths import PROJECT_ROOT, resolve_runtime_path


def test_workspace_relative_paths_follow_data_root(tmp_path):
    assert resolve_runtime_path("workspace/downloads", data_dir=tmp_path) == tmp_path / "downloads"
    assert resolve_runtime_path("notes", data_dir=tmp_path) == PROJECT_ROOT / "notes"


def test_settings_data_root_can_be_moved_outside_code(monkeypatch, tmp_path):
    data_dir = tmp_path / "Application Support" / "Read Podcast" / "workspace"
    monkeypatch.setenv("READ_PODCAST_DATA_DIR", str(data_dir))

    settings = Settings(config_path=tmp_path / "missing.yaml")

    assert settings.DATA_DIR == data_dir
    assert settings.DOWNLOAD_DIR == data_dir / "downloads"
    assert settings.STATE_FILE == data_dir / "data" / "podcast_state.json"
    assert settings.get_podcast_dir("示例节目", "markdown") == data_dir / "示例节目" / "markdown"
