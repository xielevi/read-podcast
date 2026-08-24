"""单集已读/未读状态的服务端持久化回归测试。"""
import asyncio
import sys
from pathlib import Path

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

import app.database as database
from app.standalone import app


def test_set_episode_read_then_unread_round_trip():
    async def scenario():
        await database.init_db()
        await database.set_episode_read("播客A", "第一期", True)
        assert await database.list_read_keys() == ["播客A::第一期"]

        # 重复标记已读只更新时间，不产生重复记录。
        await database.set_episode_read("播客A", "第一期", True)
        assert await database.list_read_keys() == ["播客A::第一期"]

        await database.set_episode_read("播客A", "第一期", False)
        assert await database.list_read_keys() == []

    asyncio.run(scenario())


def test_read_episode_endpoints_round_trip():
    with TestClient(app) as client:
        assert client.get("/api/read-podcast/episodes/read").json() == {
            "items": [],
            "next_offset": None,
        }

        response = client.put(
            "/api/read-podcast/episodes/read",
            json={"podcast_name": "播客B", "episode_title": "第二期", "read": True},
        )
        assert response.status_code == 200
        assert response.json() == {"ok": True}
        assert client.get("/api/read-podcast/episodes/read").json() == {
            "items": ["播客B::第二期"],
            "next_offset": None,
        }

        response = client.put(
            "/api/read-podcast/episodes/read",
            json={"podcast_name": "播客B", "episode_title": "第二期", "read": False},
        )
        assert response.status_code == 200
        assert client.get("/api/read-podcast/episodes/read").json() == {
            "items": [],
            "next_offset": None,
        }


def test_read_episode_endpoint_pages_without_losing_old_keys():
    async def seed():
        await database.init_db()
        for index in range(5):
            await database.set_episode_read("播客C", f"第{index}期", True)

    asyncio.run(seed())

    with TestClient(app) as client:
        first = client.get("/api/read-podcast/episodes/read?limit=2&offset=0")
        second = client.get("/api/read-podcast/episodes/read?limit=2&offset=2")
        third = client.get("/api/read-podcast/episodes/read?limit=2&offset=4")

    assert first.json() == {
        "items": ["播客C::第4期", "播客C::第3期"],
        "next_offset": 2,
    }
    assert second.json() == {
        "items": ["播客C::第2期", "播客C::第1期"],
        "next_offset": 4,
    }
    assert third.json() == {"items": ["播客C::第0期"], "next_offset": None}


def test_read_episode_endpoint_rejects_empty_fields():
    with TestClient(app) as client:
        response = client.put(
            "/api/read-podcast/episodes/read",
            json={"podcast_name": "", "episode_title": "第二期", "read": True},
        )
        assert response.status_code == 422
