"""测试不得读取或修改本机持久化配置。"""
from __future__ import annotations

import os

import pytest


os.environ.setdefault(
    "READ_PODCAST_CONFIG",
    f"/tmp/read-podcast-pytest-{os.getpid()}-missing-config.yaml",
)


@pytest.fixture(autouse=True)
def isolate_runtime_state(tmp_path_factory, monkeypatch):
    """所有测试使用临时任务库，并禁止 lifespan 清理真实 workspace 音频。"""
    import app.database as database
    import app.standalone as standalone

    runtime_dir = tmp_path_factory.mktemp("read-podcast-runtime")
    monkeypatch.setattr(database, "DB_PATH", runtime_dir / "read-podcast-test.db")
    monkeypatch.setattr(database, "_db", None)
    monkeypatch.setattr(database, "_db_path", None)

    async def skip_audio_cleanup():
        return {"deleted_count": 0, "freed_bytes": 0}

    monkeypatch.setattr(standalone, "_cleanup_once", skip_audio_cleanup)
    yield

    if database._db is not None:
        import asyncio

        asyncio.run(database.close_db())
