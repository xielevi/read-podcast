"""Transcription Service 运行配置与命名 helper 的单元测试。

零配置不变式：没有配置文件体系、没有 secret、没有第二配置中心——只有
内建默认值、平台路径，和用于测试隔离的显式目录覆盖。
"""
import sys

from core import config
from core.naming import safe_storage_component


def test_safe_storage_component_blocks_separators():
    out = safe_storage_component("节目/名:x")
    assert "/" not in out
    assert out.startswith("节目_名:x-")


def test_safe_storage_component_falls_back_for_empty():
    out = safe_storage_component("")
    assert out.startswith("item-")  # 空名 → fallback + 短摘要（保持唯一性）


def test_builtin_runtime_defaults():
    assert config.MAX_DOWNLOAD_BYTES >= 1024 * 1024
    assert config.DOWNLOAD_CONCURRENCY >= 1
    assert config.MAX_ACTIVE_REQUESTS >= 1
    assert config.RESULT_TTL_SECONDS >= 60


def test_builtin_topology_is_local_mlx():
    """内建引擎就是 reference deployment 的本机 MLX：端点固定为回环地址。"""
    assert config.MLX_ENDPOINT == "http://127.0.0.1:21567"


def test_service_holds_no_llm_or_business_lifecycle_config():
    # 不变式：精修、质量门禁属于 Cloudflare；本服务不持有任何 LLM 配置。
    for forbidden in ("REFINER_CONFIG", "MIN_OUTPUT_RATIO", "REFINE_CONCURRENCY"):
        assert not hasattr(config, forbidden)


def test_macos_default_data_dir_is_outside_the_repo(monkeypatch):
    if sys.platform != "darwin":
        return
    monkeypatch.delenv("READ_PODCAST_TRANSCRIPTION_DATA", raising=False)
    assert config.default_data_dir() == (
        config.Path.home() / "Library" / "Application Support" / "ReadPodcastEdge"
    ).resolve()


def test_data_dir_can_be_overridden_for_test_isolation(monkeypatch, tmp_path):
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_DATA", str(tmp_path / "data"))
    assert config.default_data_dir() == (tmp_path / "data").resolve()


def test_log_dir_can_be_overridden(monkeypatch, tmp_path):
    monkeypatch.setenv("READ_PODCAST_LOG_DIR", str(tmp_path / "logs"))
    assert config.default_log_dir() == (tmp_path / "logs").resolve()


def test_config_module_has_no_file_loading_machinery():
    """配置模块不允许任何配置文件加载机制回归（没有 YAML / dotenv / 配置路径覆盖）。"""
    source = config.Path(config.__file__).read_text(encoding="utf-8")
    for forbidden in ("import yaml", "dotenv", "safe_load", "_deep_merge", "READ_PODCAST_TRANSCRIPTION_CONFIG"):
        assert forbidden not in source
