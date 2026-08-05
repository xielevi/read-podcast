import aiosqlite
from pathlib import Path
from typing import List, Optional
from datetime import datetime
from app.models.task import Task, TaskStatus

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
DB_PATH = PROJECT_ROOT / "workspace" / "podcast2md.db"
_db: aiosqlite.Connection | None = None
_db_path: Path | None = None
ALLOWED_COLUMNS = {
    "podcast_name",
    "episode_title",
    "status",
    "progress_pct",
    "stage",
    "message",
    "output_path",
    "created_at",
    "updated_at",
}

async def init_db():
    global _db, _db_path
    if _db is not None and _db_path == DB_PATH:
        return
    if _db is not None:
        await _db.close()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    _db = await aiosqlite.connect(DB_PATH, timeout=10.0)
    _db_path = DB_PATH
    _db.row_factory = aiosqlite.Row
    await _db.execute("PRAGMA journal_mode=WAL")
    await _db.execute("PRAGMA busy_timeout=5000")
    await _db.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                podcast_name TEXT,
                episode_title TEXT,
                status TEXT,
                progress_pct INTEGER,
                stage TEXT,
                message TEXT NOT NULL DEFAULT '',
                output_path TEXT,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            )
        """)
    async with _db.execute("PRAGMA table_info(tasks)") as cursor:
        columns = {row[1] for row in await cursor.fetchall()}
    if "message" not in columns:
        await _db.execute("ALTER TABLE tasks ADD COLUMN message TEXT NOT NULL DEFAULT ''")
    await _db.execute(
        "UPDATE tasks SET message = CASE "
        "WHEN status = 'failed' THEN '转录或整理未成功；原音频已保留，可直接重试。' "
        "WHEN status = 'cancelled' THEN '任务已取消；原音频已保留，可直接重试。' "
        "WHEN status = 'success' THEN '声音整理完成！' "
        "ELSE message END WHERE message = ''"
    )
    await _db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC)")
    await _db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)")
    await _db.commit()


async def reset_stale_tasks() -> int:
    """进程启动时把上次异常退出遗留的 running/pending 僵尸任务标记为 failed。

    这些任务对应的 asyncio.Task 已随进程消失，永远不会再推进，
    否则会一直卡在「转录中」并干扰去重判断。返回被清理的行数。
    """
    db = await _connection()
    now = datetime.now()
    cursor = await db.execute(
        "UPDATE tasks SET status = 'failed', "
        "message = '服务重启，任务已中断；原音频已保留，可直接重试。', updated_at = ? "
        "WHERE status IN ('running', 'pending')",
        (now,),
    )
    await db.commit()
    return cursor.rowcount


async def close_db():
    global _db, _db_path
    if _db is not None:
        await _db.close()
        _db = None
        _db_path = None


async def _connection() -> aiosqlite.Connection:
    if _db is None or _db_path != DB_PATH:
        await init_db()
    assert _db is not None
    return _db

async def save_task(task: Task):
    db = await _connection()
    await db.execute("""
            INSERT OR REPLACE INTO tasks (id, podcast_name, episode_title, status, progress_pct, stage, message, output_path, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        task.id, task.podcast_name, task.episode_title,
        task.status.value if isinstance(task.status, TaskStatus) else task.status,
        task.progress_pct, task.stage, task.message,
        task.output_path, task.created_at, task.updated_at
    ))
    await db.commit()

async def update_task(task_id: str, **kwargs):
    if not kwargs:
        return
    unknown_columns = set(kwargs) - ALLOWED_COLUMNS
    if unknown_columns:
        raise ValueError(f"不允许更新任务字段: {', '.join(sorted(unknown_columns))}")
    kwargs['updated_at'] = datetime.now()
    if 'status' in kwargs and isinstance(kwargs['status'], TaskStatus):
        kwargs['status'] = kwargs['status'].value
        
    set_clause = ", ".join([f"{k} = ?" for k in kwargs.keys()])
    values = list(kwargs.values())
    values.append(task_id)
    
    db = await _connection()
    await db.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", values)
    await db.commit()

async def get_task(task_id: str) -> Optional[Task]:
    db = await _connection()
    async with db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)) as cursor:
        row = await cursor.fetchone()
        if row:
            return Task(**dict(row))
    return None

async def list_tasks(limit: int = 20) -> List[Task]:
    db = await _connection()
    async with db.execute("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", (limit,)) as cursor:
        rows = await cursor.fetchall()
        return [Task(**dict(row)) for row in rows]


async def delete_task(task_id: str) -> bool:
    """只删除任务记录；音频、缓存和输出文件均不在此处处理。"""
    db = await _connection()
    cursor = await db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    await db.commit()
    return cursor.rowcount > 0


async def has_successful_task(podcast_name: str, episode_title: str) -> bool:
    """判断某期节目是否已经成功转录过（用于阻止隐式重复转录）。"""
    db = await _connection()
    async with db.execute(
        "SELECT 1 FROM tasks WHERE podcast_name = ? AND episode_title = ? "
        "AND status = 'success' LIMIT 1",
        (podcast_name, episode_title),
    ) as cursor:
        return await cursor.fetchone() is not None


async def list_completed_keys() -> list[dict[str, str]]:
    db = await _connection()
    async with db.execute(
        "SELECT podcast_name, episode_title, id FROM tasks "
        "WHERE status = 'success' ORDER BY created_at DESC"
    ) as cursor:
        rows = await cursor.fetchall()

    completed: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in rows:
        key = f"{row['podcast_name']}::{row['episode_title']}"
        if key in seen:
            continue
        seen.add(key)
        completed.append({"key": key, "task_id": row["id"]})
    return completed
