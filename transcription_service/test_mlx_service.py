import asyncio
import sys
from pathlib import Path
import pytest
from starlette.testclient import TestClient

from mlx_service.server import app
from mlx_service.engine import engine


@pytest.fixture(autouse=True)
def _allow_stub(monkeypatch):
    """测试环境显式启用占位转录（真实 mlx 依赖只在生产/真机要求）。"""
    monkeypatch.setenv("READ_PODCAST_MLX_ALLOW_STUB", "1")
    monkeypatch.setattr(engine, "_model", None)


def test_mlx_health_endpoint():
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["service"] == "mlx-whisper"
    assert "model_loaded" in data


def test_mlx_transcribe_upload(tmp_path):
    client = TestClient(app)
    audio = tmp_path / "test.mp3"
    audio.write_bytes(b"dummy-audio-content")

    with open(audio, "rb") as f:
        resp = client.post(
            "/transcribe",
            files={"file": ("test.mp3", f, "audio/mpeg")},
            headers={"X-Read-Podcast-Request-ID": "req-1"},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert "text" in data
    assert data["duration"] >= 0


def test_mlx_progress_roundtrip(tmp_path):
    client = TestClient(app)

    # 验证 progress 端点的空态 / 删除语义
    d_resp = client.delete("/progress/req-path-1")
    assert d_resp.status_code == 200
    assert client.get("/progress/req-path-1").json()["progress"] == 0


def test_mlx_idle_unload(monkeypatch):
    async def _test():
        monkeypatch.setattr(engine, "idle_timeout", 0.01)
        await engine.ensure_model()
        assert engine.is_loaded is True

        # 模拟空闲超时
        await asyncio.sleep(0.05)
        await engine.unload_model()
        assert engine.is_loaded is False

    asyncio.run(_test())


def test_mlx_strict_mode_requires_real_dependency(monkeypatch):
    """未显式允许占位且缺少 mlx_whisper 时必须报错，绝不返回假转录。"""
    monkeypatch.delenv("READ_PODCAST_MLX_ALLOW_STUB", raising=False)
    monkeypatch.setattr(engine, "_model", None)
    monkeypatch.setitem(sys.modules, "mlx_whisper", None)  # 令 import mlx_whisper 抛 ImportError

    async def _test():
        with pytest.raises(RuntimeError, match="mlx_whisper"):
            await engine.ensure_model()

    asyncio.run(_test())
