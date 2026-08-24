import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch
from datetime import datetime, timedelta
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from app.standalone import app
from app.routers import episodes as episodes_module
from app.routers import tasks as tasks_module
from modules.config import settings


def test_search_podcast_with_direct_rss_url(monkeypatch):
    fake_episodes = [
        {
            "podcast_name": "Direct Test Podcast",
            "title": "Episode 1",
            "published": "2026-07-22",
            "duration": "00:30:00",
            "audio_url": "https://example.com/test.mp3",
            "link": "https://example.com/ep1",
            "summary": "Summary",
            "id": "1",
        }
    ]
    monkeypatch.setattr(episodes_module, "validate_public_url", lambda url: url)

    with patch("app.routers.episodes.RSSParser") as MockRSSParser:
        instance = MockRSSParser.return_value
        instance.fetch_episodes.return_value = fake_episodes

        with TestClient(app) as client:
            res = client.get("/api/read-podcast/search/podcast?q=https://example.com/feed.xml")
            assert res.status_code == 200
            data = res.json()
            assert len(data) >= 1
            assert data[0]["name"] == "Direct Test Podcast"
            assert data[0]["rss_url"] == "https://example.com/feed.xml"


def test_delete_subscription(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "read-podcast:\n  podcasts:\n    - name: SubToDelete\n      rss_url: https://example.com/rss\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(settings, "CONFIG_PATH", config_path)
    monkeypatch.setattr(settings, "PODCASTS", [{"name": "SubToDelete", "rss_url": "https://example.com/rss"}])

    with TestClient(app) as client:
        # Delete non-existent
        res_404 = client.delete("/api/read-podcast/subscriptions/NonExistent")
        assert res_404.status_code == 404

        # Delete existing
        res_200 = client.delete("/api/read-podcast/subscriptions/SubToDelete")
        assert res_200.status_code == 200
        assert res_200.json()["status"] == "ok"
        assert settings.PODCASTS == []


def test_get_episodes_swr_cache(monkeypatch):
    monkeypatch.setattr(settings, "PODCASTS", [{"name": "SWRPodcast", "rss_url": "https://example.com/swr.xml"}])
    scheduled = []
    monkeypatch.setattr(episodes_module, "_schedule_episode_refresh", lambda name, url: scheduled.append((name, url)))
    episodes_module._episodes_cache["SWRPodcast"] = {
        "data": [{"title": "Cached Ep 1", "published": "", "duration": "", "duration_seconds": 0, "audio_url": "", "link": "", "summary": ""}],
        "ts": 1000.0,  # Expired timestamp
        "min_duration": 0,
    }

    with TestClient(app) as client:
        # With SWR, expired cache returns immediately while triggering background refresh
        res = client.get("/api/read-podcast/episodes?podcast_name=SWRPodcast")
        assert res.status_code == 200
        data = res.json()
        assert len(data) == 1
        assert data[0]["title"] == "Cached Ep 1"
        assert scheduled == [("SWRPodcast", "https://example.com/swr.xml")]


def test_get_episodes_cold_cache_returns_preview_and_schedules_full_refresh(monkeypatch):
    monkeypatch.setattr(settings, "PODCASTS", [{"name": "ColdPodcast", "rss_url": "https://example.com/cold.xml"}])
    episodes_module._episodes_cache.pop("ColdPodcast", None)
    fetch_limits = []
    scheduled = []

    def fake_fetch(podcast_name, rss_url, limit=9999, min_duration_seconds=0):
        fetch_limits.append(limit)
        return [
            {"title": f"Episode {index}", "published": "", "duration": "", "duration_seconds": 0, "audio_url": "", "link": "", "summary": ""}
            for index in range(limit)
        ]

    monkeypatch.setattr(episodes_module, "_fetch_episodes_sync", fake_fetch)
    monkeypatch.setattr(episodes_module, "_save_persistent_cache", lambda cache: None)
    monkeypatch.setattr(episodes_module, "_schedule_episode_refresh", lambda name, url: scheduled.append((name, url)))

    with TestClient(app) as client:
        response = client.get("/api/read-podcast/episodes?podcast_name=ColdPodcast&limit=10")

    assert response.status_code == 200
    assert response.headers["x-read-podcast-cache-state"] == "warming"
    assert response.headers["x-podcast2md-cache-state"] == "warming"
    assert len(response.json()) == 10
    assert fetch_limits == [episodes_module.EPISODE_PREVIEW_LIMIT]
    assert scheduled == [("ColdPodcast", "https://example.com/cold.xml")]


def test_get_episodes_limits_cached_payload(monkeypatch):
    monkeypatch.setattr(settings, "PODCASTS", [{"name": "PagedPodcast", "rss_url": "https://example.com/paged.xml"}])
    episodes_module._episodes_cache["PagedPodcast"] = {
        "data": [{"title": f"Cached Ep {index}", "published": "", "duration": "", "duration_seconds": 0, "audio_url": "", "link": "", "summary": ""} for index in range(12)],
        "ts": 2_000_000_000.0,
        "complete": True,
        "min_duration": 0,
    }

    with TestClient(app) as client:
        response = client.get("/api/read-podcast/episodes?podcast_name=PagedPodcast&limit=10")

    assert response.status_code == 200
    assert len(response.json()) == 10
    assert response.headers["x-read-podcast-cache-state"] == "complete"


def test_get_episodes_resumes_incomplete_cache_refresh(monkeypatch):
    monkeypatch.setattr(settings, "PODCASTS", [{"name": "WarmingPodcast", "rss_url": "https://example.com/warming.xml"}])
    episodes_module._episodes_cache["WarmingPodcast"] = {
        "data": [{"title": "Preview Ep", "published": "", "duration": "", "duration_seconds": 0, "audio_url": "", "link": "", "summary": ""}],
        "ts": 2_000_000_000.0,
        "complete": False,
        "min_duration": 0,
    }
    episodes_module._episode_refresh_tasks.pop("WarmingPodcast", None)

    async def fake_refresh(podcast_name, rss_url):
        data = [
            {"title": "Preview Ep", "published": "", "duration": "", "duration_seconds": 0, "audio_url": "", "link": "", "summary": ""},
            {"title": "Older Ep", "published": "", "duration": "", "duration_seconds": 0, "audio_url": "", "link": "", "summary": ""},
        ]
        episodes_module._episodes_cache[podcast_name] = {"data": data, "ts": 2_000_000_001.0, "complete": True, "min_duration": 0}
        return data

    monkeypatch.setattr(episodes_module, "refresh_episodes_cache", fake_refresh)

    with TestClient(app) as client:
        response = client.get("/api/read-podcast/episodes?podcast_name=WarmingPodcast&limit=0")

    assert response.status_code == 200
    assert response.headers["x-read-podcast-cache-state"] == "complete"
    assert len(response.json()) == 2


def test_get_episodes_applies_duration_filter(monkeypatch):
    podcast_name = "DurationPodcast"
    monkeypatch.setattr(
        settings,
        "PODCASTS",
        [{"name": podcast_name, "rss_url": "https://example.com/duration.xml", "filter": {"min_duration_seconds": 600}}],
    )
    episodes_module._episodes_cache.pop(podcast_name, None)
    episodes = [
        {"title": "短集", "duration_seconds": 300, "duration": "00:05:00", "audio_url": "https://example.com/short.mp3"},
        {"title": "长集", "duration_seconds": 1200, "duration": "00:20:00", "audio_url": "https://example.com/long.mp3"},
    ]

    def fake_fetch(podcast_name, rss_url, limit=9999, min_duration_seconds=0):
        assert min_duration_seconds == 600
        return [episode for episode in episodes if episode["duration_seconds"] >= min_duration_seconds][:limit]

    monkeypatch.setattr(episodes_module, "_fetch_episodes_sync", fake_fetch)
    monkeypatch.setattr(episodes_module, "_save_persistent_cache", lambda cache: None)
    monkeypatch.setattr(episodes_module, "_schedule_episode_refresh", lambda name, url: None)

    with TestClient(app) as client:
        response = client.get(f"/api/read-podcast/episodes?podcast_name={podcast_name}&limit=10")

    assert response.status_code == 200
    assert [episode["title"] for episode in response.json()] == ["长集"]


def test_completed_keys_pages_all_tasks_and_keeps_newest_duplicate(tmp_path, monkeypatch):
    import app.database as database
    from app.models.task import Task, TaskStatus

    db_path = tmp_path / "tasks.db"
    monkeypatch.setattr(database, "DB_PATH", db_path)

    async def seed():
        await database.init_db()
        base = datetime.now() - timedelta(minutes=30)
        for index in range(25):
            created = base + timedelta(seconds=index)
            await database.save_task(Task(
                id=f"task-{index}",
                podcast_name="Long Podcast",
                episode_title=f"Episode {index}",
                status=TaskStatus.SUCCESS,
                progress_pct=100,
                stage="done",
                created_at=created,
                updated_at=created,
            ))
        await database.save_task(Task(
            id="task-0-newer",
            podcast_name="Long Podcast",
            episode_title="Episode 0",
            status=TaskStatus.SUCCESS,
            progress_pct=100,
            stage="done",
            created_at=base + timedelta(minutes=1),
            updated_at=base + timedelta(minutes=1),
        ))

    import asyncio
    asyncio.run(seed())
    monkeypatch.setattr(tasks_module, "list_completed_keys", database.list_completed_keys)

    with TestClient(app) as client:
        first = client.get("/api/read-podcast/tasks/completed-keys?limit=10&offset=0")
        second = client.get("/api/read-podcast/tasks/completed-keys?limit=10&offset=10")
        third = client.get("/api/read-podcast/tasks/completed-keys?limit=10&offset=20")

    assert first.status_code == 200
    assert first.json()["next_offset"] == 10
    assert second.json()["next_offset"] == 20
    assert third.json()["next_offset"] is None
    keys = first.json()["items"] + second.json()["items"] + third.json()["items"]
    assert len(keys) == 25
    assert {item["key"] for item in keys}.__contains__("Long Podcast::Episode 0")
    assert keys[0] == {"key": "Long Podcast::Episode 0", "task_id": "task-0-newer"}


def test_failed_task_can_be_cleared_without_touching_artifacts(monkeypatch):
    from app.models.task import Task, TaskStatus

    failed = Task(
        id="failed-task",
        podcast_name="东腔西调",
        episode_title="Vol.273",
        status=TaskStatus.FAILED,
    )
    delete = AsyncMock(return_value=True)
    monkeypatch.setattr(tasks_module, "get_task", AsyncMock(return_value=failed))
    monkeypatch.setattr(tasks_module, "delete_task", delete)

    response = asyncio.run(tasks_module.cancel_task_endpoint("failed-task"))

    assert response == {"task_id": "failed-task", "status": "deleted"}
    delete.assert_awaited_once_with("failed-task")


def test_failed_task_retry_replaces_old_record(monkeypatch):
    from app.models.task import Task, TaskStatus

    failed = Task(
        id="failed-task",
        podcast_name="东腔西调",
        episode_title="Vol.273",
        status=TaskStatus.FAILED,
    )
    create = AsyncMock(return_value="new-task")
    delete = AsyncMock(return_value=True)
    monkeypatch.setattr(tasks_module, "get_task", AsyncMock(return_value=failed))
    monkeypatch.setattr(tasks_module, "create_and_start_task", create)
    monkeypatch.setattr(tasks_module, "delete_task", delete)

    response = asyncio.run(tasks_module.retry_task_endpoint("failed-task"))

    assert response["task_id"] == "new-task"
    create.assert_awaited_once_with("东腔西调", "Vol.273", force=True)
    delete.assert_awaited_once_with("failed-task")


def test_create_task_requires_json_body_not_query_params():
    """稳定版收口：POST /tasks 只接受 JSON body，旧的纯 query 参数不再被接受。"""
    with TestClient(app) as client:
        # 只带 query 参数、没有 JSON body：应被 Pydantic 拒绝为 422，而不是静默建任务。
        res = client.post(
            "/api/read-podcast/tasks"
            "?podcast_name=P&episode_title=E&force=true"
        )
        assert res.status_code == 422


def test_create_task_accepts_json_body(monkeypatch):
    with patch("app.routers.tasks.create_and_start_task", new=AsyncMock(return_value="task-123")) as create:
        with TestClient(app) as client:
            res = client.post(
                "/api/read-podcast/tasks",
                json={"podcast_name": "东腔西调", "episode_title": "Vol.273", "force": True},
            )
    assert res.status_code == 200
    assert res.json() == {"task_id": "task-123", "status": "created"}
    create.assert_awaited_once_with("东腔西调", "Vol.273", force=True)


def test_create_task_rejects_overlong_title():
    with TestClient(app) as client:
        res = client.post(
            "/api/read-podcast/tasks",
            json={"podcast_name": "P", "episode_title": "x" * 1001},
        )
        assert res.status_code == 422
