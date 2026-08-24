"""转录任务生命周期、音频上传、稿件正文/下载、模板列表。"""
from __future__ import annotations

import logging
import uuid as _uuid
from pathlib import Path
from typing import Dict, List

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from app.database import (
    delete_task,
    get_task,
    list_completed_keys,
    list_tasks,
)
from app.models.task import Task, TaskStatus
from app.routers._shared import read_task_output_text
from app.schemas import CreateTaskRequest, CustomTaskRequest, PublicTask
from app.sse import notifier
from app.tasks import (
    AlreadyProcessedError,
    DuplicateTaskError,
    cancel_task,
    create_and_start_custom_task,
    create_and_start_task,
    safe_progress_message,
)
from modules.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Read Podcast"])

UPLOAD_DIR = settings.DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
ALLOWED_AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac", ".opus", ".wma"}
MAX_UPLOAD_BYTES = max(
    1,
    int(settings.RUNTIME_CONFIG.get("max_upload_bytes", 2 * 1024 * 1024 * 1024)),
)
KEY_PAGE_SIZE = 200
KEY_PAGE_MAX = 500


def _public_task(task: Task) -> PublicTask:
    data = task.model_dump()
    data["message"] = safe_progress_message(task.stage, task.message)
    return PublicTask.model_validate(data)


@router.post("/tasks")
async def create_task(body: CreateTaskRequest) -> Dict[str, str]:
    # 只收 JSON body：统一走 Pydantic 的长度/类型校验，杜绝旧 query 分支绕过校验。
    try:
        task_id = await create_and_start_task(
            body.podcast_name,
            body.episode_title,
            force=body.force,
        )
    except DuplicateTaskError as exc:
        # 同一节目已在处理中：回传既有任务，前端据此复用而非重复排队。
        return {"task_id": exc.task_id, "status": "existing"}
    except AlreadyProcessedError:
        raise HTTPException(
            status_code=409,
            detail="该节目已转录完成，如需重做请点击「重新转录」。",
        )
    return {"task_id": task_id, "status": "created"}


@router.delete("/tasks/{task_id}")
async def cancel_task_endpoint(task_id: str) -> Dict[str, str]:
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")
    if task.status in {TaskStatus.PENDING, TaskStatus.RUNNING}:
        cancelled = await cancel_task(task_id)
        if not cancelled:
            raise HTTPException(status_code=409, detail="任务进程已结束，请刷新后重试")
        return {"task_id": task_id, "status": "cancelling"}
    if task.status in {TaskStatus.FAILED, TaskStatus.CANCELLED}:
        await delete_task(task_id)
        return {"task_id": task_id, "status": "deleted"}
    raise HTTPException(status_code=409, detail="已完成稿件请在稿件库中保留")


@router.post("/tasks/{task_id}/retry")
async def retry_task_endpoint(task_id: str) -> Dict[str, str]:
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")
    if task.status not in {TaskStatus.FAILED, TaskStatus.CANCELLED}:
        raise HTTPException(status_code=409, detail="只有失败或已取消的任务可以重试")
    try:
        new_task_id = await create_and_start_task(
            task.podcast_name,
            task.episode_title,
            force=True,
        )
    except DuplicateTaskError as exc:
        new_task_id = exc.task_id
    await delete_task(task_id)
    return {"task_id": new_task_id, "replaces_task_id": task_id, "status": "created"}


@router.post("/tasks/custom")
async def create_custom_task(body: CustomTaskRequest) -> Dict[str, str]:
    filename = body.audio_filename.strip()
    custom_prompt = body.custom_prompt.strip()
    if not filename or not custom_prompt:
        raise HTTPException(status_code=400, detail="audio_filename 和 custom_prompt 均为必填项")

    # 验证 custom_prompt 必须属于系统预设模板，防止恶意自定义提示词
    valid_prompts = {t.get("content", "").strip() for t in (settings.PROMPT_TEMPLATES or [])}
    if custom_prompt not in valid_prompts:
        raise HTTPException(status_code=400, detail="不允许自定义提示词，请选择系统预设的整理模板。")

    # 安全沙箱路径防御：仅允许操作 uploads 目录下的已上传文件
    p = Path(filename)
    if p.name != filename:
        raise HTTPException(status_code=400, detail="文件名非法")

    workspace_dir = settings.DATA_DIR
    resolved_audio = workspace_dir / "uploads" / filename
    resolved_output = workspace_dir / "custom_outputs"
    resolved_output.mkdir(parents=True, exist_ok=True)

    if not resolved_audio.exists():
        raise HTTPException(status_code=400, detail="音频文件不存在，请重新上传。")

    task_id = await create_and_start_custom_task(str(resolved_audio), str(resolved_output), custom_prompt)
    return {"task_id": task_id}


@router.get("/tasks")
async def get_all_tasks(limit: int = Query(20, ge=1, le=200)) -> List[PublicTask]:
    return [_public_task(task) for task in await list_tasks(limit)]


@router.get("/tasks/completed-keys")
async def get_completed_task_keys(
    limit: int = Query(KEY_PAGE_SIZE, ge=1, le=KEY_PAGE_MAX),
    offset: int = Query(0, ge=0),
) -> Dict:
    rows = await list_completed_keys(limit=limit + 1, offset=offset)
    has_more = len(rows) > limit
    return {
        "items": rows[:limit],
        "next_offset": offset + limit if has_more else None,
    }


@router.get("/tasks/stream")
async def stream_all_task_logs():
    return StreamingResponse(
        notifier.subscribe(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/tasks/{task_id}")
async def get_task_status(task_id: str) -> PublicTask:
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")
    return _public_task(task)


@router.get("/tasks/{task_id}/stream")
async def stream_task_logs(task_id: str):
    return StreamingResponse(
        notifier.subscribe(task_id),
        media_type="text/event-stream"
    )


@router.get("/tasks/{task_id}/content")
async def get_task_content(task_id: str) -> Dict[str, str]:
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")

    output_file, content = read_task_output_text(task)

    return {
        "task_id": task_id,
        "title": task.episode_title or output_file.name,
        "filename": output_file.name,
        "content": content,
    }


@router.get("/tasks/{task_id}/download")
async def download_task_output(task_id: str):
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")
    if not task.output_path or not Path(task.output_path).exists():
        raise HTTPException(status_code=404, detail="输出文件尚未生成或已被删除")
    return FileResponse(
        path=task.output_path,
        media_type="text/markdown",
        filename=Path(task.output_path).name,
    )


@router.post("/upload/audio")
async def upload_audio(file: UploadFile = File(...)) -> Dict:
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名不能为空")
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_AUDIO_EXTS:
        raise HTTPException(status_code=400, detail=f"不支持的文件格式：{ext}")
    truncated_stem = Path(file.filename).stem[:80]
    save_name = f"{_uuid.uuid4().hex[:8]}_{truncated_stem}{ext}"
    save_path = UPLOAD_DIR / save_name
    temp_path = save_path.with_suffix(f"{save_path.suffix}.part")
    total_bytes = 0
    try:
        with temp_path.open("wb") as f:
            while chunk := await file.read(1024 * 1024):
                total_bytes += len(chunk)
                if total_bytes > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="音频文件超过允许大小")
                f.write(chunk)
        temp_path.replace(save_path)
    except HTTPException:
        temp_path.unlink(missing_ok=True)
        raise
    except Exception as e:
        temp_path.unlink(missing_ok=True)
        logger.exception("上传文件保存失败")
        raise HTTPException(status_code=500, detail="文件保存失败") from e
    finally:
        await file.close()
    return {
        "filename": save_name,
        "original_name": file.filename,
        "server_path": save_name,  # 只返回文件名作为标识符，杜绝物理绝对路径泄露
        "size": save_path.stat().st_size,
    }


@router.get("/prompt-templates")
async def get_prompt_templates() -> List[Dict]:
    return settings.PROMPT_TEMPLATES or []
