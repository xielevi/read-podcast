"""任务排队去重、重复防护与取消逻辑的回归测试。"""
import asyncio
import sys
import threading
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

import app.database as database
import app.tasks as tasks
from app.models.task import Task, TaskStatus


@pytest.mark.parametrize("worker_fails", [False, True])
def test_cancellation_keeps_slot_and_key_until_thread_finishes(fresh_db, monkeypatch, worker_fails):
    async def scenario():
        started = asyncio.Event()
        release = threading.Event()
        slot = asyncio.Lock()
        loop = asyncio.get_running_loop()
        events = []

        def worker():
            loop.call_soon_threadsafe(started.set)
            if not release.wait(timeout=3):
                raise TimeoutError("test did not release worker")
            if worker_fails:
                raise RuntimeError("late worker failure")

        async def runner():
            await asyncio.to_thread(worker)

        async def unexpected_stage():
            pytest.fail("cancelled task entered its next stage")

        async def capture(_task_id, payload):
            events.append(payload)

        async def pipeline(task_id, *_args, **_kwargs):
            await tasks._run_stages(task_id, [
                (slot, "transcribing", "转录中", runner),
                (slot, "refining", "精修中", unexpected_stage),
            ], lambda: None, "完成")

        monkeypatch.setattr(tasks, "run_pipeline", pipeline)
        monkeypatch.setattr(tasks.notifier, "push", capture)
        task_id = await tasks.create_and_start_task("播客", "取消测试")
        background = tasks._task_registry[task_id]
        try:
            await asyncio.wait_for(started.wait(), timeout=1)
            for _ in range(2):
                assert await tasks.cancel_task(task_id)
                await asyncio.sleep(0)
                assert slot.locked()
                assert not background.done()
            with pytest.raises(tasks.DuplicateTaskError):
                await tasks.create_and_start_task("播客", "取消测试")
        finally:
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(background, timeout=2)

        assert not slot.locked()
        assert "播客::取消测试" not in tasks._active_keys
        stored = await database.get_task(task_id)
        assert stored.status == TaskStatus.CANCELLED
        assert events[-1]["status"] == "cancelled"
        assert not any(event["stage"] == "refining" for event in events)

    asyncio.run(scenario())


@pytest.fixture
def fresh_db(tmp_path, monkeypatch):
    """每个用例使用独立的临时数据库并清空进程内的任务注册表。"""
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "tasks.db")
    monkeypatch.setattr(database, "_db", None)
    monkeypatch.setattr(database, "_db_path", None)
    tasks._task_registry.clear()
    tasks._active_keys.clear()
    yield
    tasks._task_registry.clear()
    tasks._active_keys.clear()


async def _seed_success(podcast_name: str, episode_title: str) -> None:
    await database.init_db()
    await database.save_task(Task(
        id="done-1",
        podcast_name=podcast_name,
        episode_title=episode_title,
        status=TaskStatus.SUCCESS,
        progress_pct=100,
        stage="done",
    ))


def _make_blocking_stub():
    """替身 pipeline：一直阻塞，直到被取消时标记为 CANCELLED。"""
    started = asyncio.Event()

    async def stub(task_id, *args, **kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await tasks._mark_cancelled(task_id)
            raise

    return stub, started


def test_duplicate_click_returns_existing_task(fresh_db, monkeypatch):
    async def scenario():
        stub, started = _make_blocking_stub()
        monkeypatch.setattr(tasks, "run_pipeline", stub)
        await database.init_db()

        first_id = await tasks.create_and_start_task("忽左忽右", "第 487 期")
        await asyncio.wait_for(started.wait(), timeout=1)

        # 第二次点击同一节目：不新建，抛出 DuplicateTaskError 并回传既有 id。
        with pytest.raises(tasks.DuplicateTaskError) as excinfo:
            await tasks.create_and_start_task("忽左忽右", "第 487 期")
        assert excinfo.value.task_id == first_id
        assert len(tasks._task_registry) == 1

        assert await tasks.cancel_task(first_id) is True
        await asyncio.sleep(0.05)

    asyncio.run(scenario())


def test_already_processed_blocks_implicit_rerun(fresh_db, monkeypatch):
    async def scenario():
        stub, started = _make_blocking_stub()
        monkeypatch.setattr(tasks, "run_pipeline", stub)
        await _seed_success("忽左忽右", "第 487 期")

        # force=False：已成功转录过 → 拒绝隐式重跑。
        with pytest.raises(tasks.AlreadyProcessedError):
            await tasks.create_and_start_task("忽左忽右", "第 487 期", force=False)

        # force=True：显式「重新转录」允许重跑。
        new_id = await tasks.create_and_start_task("忽左忽右", "第 487 期", force=True)
        await asyncio.wait_for(started.wait(), timeout=1)
        assert new_id in tasks._task_registry

        assert await tasks.cancel_task(new_id) is True
        await asyncio.sleep(0.05)

    asyncio.run(scenario())


def test_cancel_marks_task_cancelled_and_frees_key(fresh_db, monkeypatch):
    async def scenario():
        stub, started = _make_blocking_stub()
        monkeypatch.setattr(tasks, "run_pipeline", stub)
        await database.init_db()

        task_id = await tasks.create_and_start_task("忽左忽右", "第 488 期")
        await asyncio.wait_for(started.wait(), timeout=1)

        assert await tasks.cancel_task(task_id) is True
        await asyncio.sleep(0.05)

        stored = await database.get_task(task_id)
        assert stored.status == TaskStatus.CANCELLED
        # 取消后去重键被释放，允许重新发起同一节目。
        assert "忽左忽右::第 488 期" not in tasks._active_keys
        # 取消不存在/已结束的任务返回 False。
        assert await tasks.cancel_task(task_id) is False

    asyncio.run(scenario())


def test_failure_preserves_last_real_progress_and_message(fresh_db, monkeypatch):
    async def scenario():
        await database.init_db()
        await database.save_task(Task(
            id="failed-progress",
            podcast_name="东腔西调",
            episode_title="Vol.273",
            status=TaskStatus.RUNNING,
            progress_pct=29,
            stage="transcribing",
            message="正在上传音频…",
        ))
        events = []

        async def capture(_task_id, payload):
            events.append(payload)

        monkeypatch.setattr(tasks.notifier, "push", capture)
        await tasks._mark_failed("failed-progress", RuntimeError("private backend detail"))

        stored = await database.get_task("failed-progress")
        assert stored.status == TaskStatus.FAILED
        assert stored.stage == "transcribing"
        assert stored.progress_pct == 29
        assert stored.message == "转录或整理未成功；原音频已保留，可直接重试。"
        assert events[-1]["progress"] == 29
        assert events[-1]["status"] == "failed"
        assert "private backend detail" not in events[-1]["message"]

    asyncio.run(scenario())


def test_success_sse_event_does_not_expose_output_path(tmp_path, monkeypatch):
    async def scenario():
        output_file = tmp_path / "finished.md"
        output_file.write_text("done", encoding="utf-8")
        events = []

        async def ignore_update(*_args, **_kwargs):
            return None

        async def capture(_task_id, payload):
            events.append(payload)

        monkeypatch.setattr(tasks, "update_task", ignore_update)
        monkeypatch.setattr(tasks.notifier, "push", capture)
        await tasks._run_stages("safe-event", [], lambda: output_file, "完成")

        assert events[-1]["status"] == "success"
        assert "output_path" not in events[-1]
        assert str(tmp_path) not in str(events[-1])

    asyncio.run(scenario())


def test_delete_task_only_removes_database_record(fresh_db):
    async def scenario():
        await database.init_db()
        await database.save_task(Task(
            id="failed-delete",
            podcast_name="东腔西调",
            episode_title="Vol.273",
            status=TaskStatus.FAILED,
        ))

        assert await database.delete_task("failed-delete") is True
        assert await database.get_task("failed-delete") is None
        assert await database.delete_task("failed-delete") is False

    asyncio.run(scenario())
