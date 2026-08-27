import pytest

from modules.config import ConfigurationError, Settings, validate_podcast_name
from modules.pipeline import build_filename_base
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


def test_podcast_storage_names_reject_path_semantics():
    assert validate_podcast_name("中文 节目.V2") == "中文 节目.V2"
    for value in (".", "..", "a/b", "a\\b", "/tmp/escape", "C:\\escape", "NUL"):
        with pytest.raises(ValueError):
            validate_podcast_name(value)


def test_settings_rejects_unsafe_persisted_podcast_name(tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "podcasts:\n  - name: '..'\n    rss_url: https://example.com/feed\n",
        encoding="utf-8",
    )

    with pytest.raises(ConfigurationError, match="无效的节目名称"):
        Settings(config_path)


def test_podcast_directory_rejects_escape_symlink(monkeypatch, tmp_path):
    data_dir = tmp_path / "workspace"
    outside = tmp_path / "outside"
    outside.mkdir()
    data_dir.mkdir()
    (data_dir / "escape").symlink_to(outside, target_is_directory=True)
    monkeypatch.setenv("READ_PODCAST_DATA_DIR", str(data_dir))
    loaded = Settings(config_path=tmp_path / "missing.yaml")

    with pytest.raises(ConfigurationError, match="数据目录"):
        loaded.get_podcast_dir("escape", "downloads")


def test_filename_base_sanitizes_feed_path_characters():
    normal = build_filename_base("示例节目", "2026-08-27", "Vol.2｜正常 标题.V2")
    unsafe = build_filename_base("示例节目", "2026-08-27", "../../外部\\标题")

    assert normal == "2026-08-27_示例节目_Vol.2_正常 标题.V2"
    assert "/" not in unsafe
    assert "\\" not in unsafe
    assert unsafe.startswith("2026-08-27_示例节目_")


def test_explicit_external_markdown_root_remains_supported(monkeypatch, tmp_path):
    output_dir = tmp_path / "Obsidian" / "播客"
    monkeypatch.setenv("READ_PODCAST_OUTPUT_DIR", str(output_dir))
    loaded = Settings(config_path=tmp_path / "missing.yaml")

    assert loaded.get_podcast_dir("示例节目", "markdown") == output_dir
