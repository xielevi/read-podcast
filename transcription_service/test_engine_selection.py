"""转录引擎选择：Apple Silicon 默认 MLX，其他平台默认 Faster-Whisper，环境变量可强制。

选择策略属于服务内部实现（``core.config.resolve_engine``），对外协议不变。这里同时
验证 Faster-Whisper 运行参数的内建默认值与「仅环境变量可覆盖」的零配置边界。
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

import core.config as config
import core.transcriber as transcriber
from core.config import ENGINE_ENV_VAR
from core.faster_whisper_engine import FasterWhisperTranscriber
from core.transcriber import WhisperApiTranscriber, engine_name, get_transcriber


def auto_platform(monkeypatch, *, platform="linux", machine="x86_64"):
    """把宿主伪装成给定平台，并清掉显式引擎覆盖（进入 auto 路径）。"""
    monkeypatch.delenv(ENGINE_ENV_VAR, raising=False)
    monkeypatch.setattr(config.sys, "platform", platform)
    monkeypatch.setattr(config.platform, "machine", lambda: machine)


# ── auto：按平台内建默认 ──

def test_auto_apple_silicon_defaults_to_mlx(monkeypatch):
    auto_platform(monkeypatch, platform="darwin", machine="arm64")
    assert isinstance(get_transcriber(), WhisperApiTranscriber)
    assert engine_name() == "mlx"


def test_auto_linux_defaults_to_faster_whisper(monkeypatch):
    auto_platform(monkeypatch, platform="linux", machine="x86_64")
    assert isinstance(get_transcriber(), FasterWhisperTranscriber)
    assert engine_name() == "faster-whisper"


def test_auto_intel_mac_defaults_to_faster_whisper(monkeypatch):
    auto_platform(monkeypatch, platform="darwin", machine="x86_64")
    assert isinstance(get_transcriber(), FasterWhisperTranscriber)


# ── 环境变量强制指定 ──

def test_env_forces_engine_on_any_platform(monkeypatch):
    auto_platform(monkeypatch, platform="linux")
    monkeypatch.setenv(ENGINE_ENV_VAR, "mlx")
    assert isinstance(get_transcriber(), WhisperApiTranscriber)

    auto_platform(monkeypatch, platform="darwin", machine="arm64")
    monkeypatch.setenv(ENGINE_ENV_VAR, "faster-whisper")
    assert isinstance(get_transcriber(), FasterWhisperTranscriber)


def test_env_value_is_normalized(monkeypatch):
    auto_platform(monkeypatch, platform="linux")
    monkeypatch.setenv(ENGINE_ENV_VAR, "  MLX ")
    assert engine_name() == "mlx"


def test_env_auto_explicitly_keeps_platform_default(monkeypatch):
    auto_platform(monkeypatch, platform="darwin", machine="arm64")
    monkeypatch.setenv(ENGINE_ENV_VAR, "auto")
    assert isinstance(get_transcriber(), WhisperApiTranscriber)


def test_invalid_engine_value_fails_loudly(monkeypatch):
    auto_platform(monkeypatch, platform="linux")
    monkeypatch.setenv(ENGINE_ENV_VAR, "whisperx")
    with pytest.raises(ValueError):
        get_transcriber()


# ── Faster-Whisper 运行参数：内建默认值 + 仅环境变量可覆盖 ──

def test_faster_whisper_options_built_in_defaults(monkeypatch):
    auto_platform(monkeypatch, platform="linux")
    options = config.faster_whisper_options()
    assert options.model == config.DEFAULT_FASTER_WHISPER_MODEL
    assert options.device == config.DEFAULT_FASTER_WHISPER_DEVICE
    assert options.compute_type == config.DEFAULT_FASTER_WHISPER_COMPUTE_TYPE
    assert options.cpu_threads == config.DEFAULT_FASTER_WHISPER_CPU_THREADS


def test_faster_whisper_options_env_overrides(monkeypatch):
    auto_platform(monkeypatch, platform="linux")
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_MODEL", "small")
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_DEVICE", "cuda")
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_COMPUTE_TYPE", "float16")
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_CPU_THREADS", "3")
    options = config.faster_whisper_options()
    assert (options.model, options.device, options.compute_type, options.cpu_threads) == (
        "small",
        "cuda",
        "float16",
        3,
    )


def test_faster_whisper_cpu_threads_rejects_garbage(monkeypatch):
    auto_platform(monkeypatch, platform="linux")
    monkeypatch.setenv("READ_PODCAST_TRANSCRIPTION_CPU_THREADS", "many")
    with pytest.raises(ValueError):
        config.faster_whisper_options()


# ── /health 反映实际选择的引擎 ──

def test_health_reports_the_selected_engine(monkeypatch):
    from fastapi.testclient import TestClient

    from jobs import JobManager
    from service import create_app

    auto_platform(monkeypatch, platform="linux")
    with TestClient(create_app(JobManager(tempfile.mkdtemp()))) as client:
        body = client.get("/health").json()
        assert body["engine"] == engine_name() == "faster-whisper"


def test_transcriber_source_holds_no_credential_or_env_machinery():
    """引擎适配层不读环境、不持令牌（env 解析只属于 core.config）。"""
    source = Path(transcriber.__file__).read_text(encoding="utf-8")
    for forbidden in ("Authorization", "API_TOKEN", "API_KEY", "getenv", "environ"):
        assert forbidden not in source


def test_faster_whisper_transcriber_is_process_singleton(monkeypatch):
    """JobManager 每个任务都调用 get_transcriber()：模型必须常驻，不能每个任务重新加载。"""
    auto_platform(monkeypatch, platform="linux")
    monkeypatch.setattr(transcriber, "_faster_whisper", None)
    assert get_transcriber() is get_transcriber()
