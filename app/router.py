"""
Read Podcast API Router
=====================
从原 app/main.py 提取的所有路由，作为 APIRouter 挂载到统一后端。
规范前缀: /api/read-podcast（旧前缀由部署入口兼容挂载）
"""
from __future__ import annotations

import json
import uuid as _uuid
import asyncio
import time
import yaml
import logging
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List

import httpx
from fastapi import APIRouter, HTTPException, UploadFile, File, Query, Response
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel, Field

from app.models.task import Task, TaskStatus
from app.database import delete_task, get_task, list_completed_keys, list_tasks
from app.tasks import (
    AlreadyProcessedError,
    DuplicateTaskError,
    cancel_task,
    create_and_start_task,
    create_and_start_custom_task,
    safe_progress_message,
)
from app.sse import notifier
from modules.config import settings
from modules.formatter import strip_leading_frontmatter
from modules.refiner import AssistantError, assistant_available, chat_completion
from modules.rss_parser import RSSParser
from modules.network_security import UnsafeUrlError, validate_public_url

logger = logging.getLogger(__name__)

_config_lock = asyncio.Lock()
_background_tasks: set[asyncio.Task] = set()

# 健康检查保持独立，其他 API 是否需要认证由 standalone 中间件统一决定。
router = APIRouter(tags=["Read Podcast"])
api_router = router


# ── Pydantic 模型 ──

class AddPodcastRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    rss_url: str = Field(min_length=1, max_length=2048)

class CreateTaskRequest(BaseModel):
    podcast_name: str = Field(min_length=1, max_length=200)
    episode_title: str = Field(min_length=1, max_length=500)
    force: bool = False

class CustomTaskRequest(BaseModel):
    audio_filename: str = Field(min_length=1, max_length=255)
    custom_prompt: str = Field(min_length=1, max_length=100_000)

class LookupRequest(BaseModel):
    term: str = Field(min_length=1, max_length=200)
    context: str = Field(default="", max_length=4000)

class ChatMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=4000)

class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: List[ChatMessage] = Field(default_factory=list)

class PublicTask(BaseModel):
    id: str
    podcast_name: str
    episode_title: str
    status: TaskStatus
    progress_pct: int
    stage: str
    message: str
    created_at: datetime
    updated_at: datetime


def _public_task(task: Task) -> PublicTask:
    data = task.model_dump()
    data["message"] = safe_progress_message(task.stage, task.message)
    return PublicTask.model_validate(data)


# ── 路径常量 ──

READ_PODCAST_ROOT = Path(__file__).parent.parent.absolute()
CACHE_DIR = READ_PODCAST_ROOT / "workspace" / "data"
CACHE_FILE = CACHE_DIR / "episodes_cache.json"
CACHE_TTL_SECONDS = 3600
EPISODE_PREVIEW_LIMIT = 10
UPLOAD_DIR = READ_PODCAST_ROOT / "workspace" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
ALLOWED_AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac", ".opus", ".wma"}
ALLOWED_TEXT_OUTPUT_EXTS = {".md", ".markdown", ".txt"}
# AI 助手灌入模型的文字稿上下文预算（字符）；超长稿件截断以控制延迟与成本。
ASSISTANT_CONTEXT_CHAR_BUDGET = 24000
# 每次对话最多回带的历史轮数，防止 prompt 无限膨胀。
ASSISTANT_MAX_HISTORY = 8
MAX_UPLOAD_BYTES = max(
    1,
    int(settings.RUNTIME_CONFIG.get("max_upload_bytes", 2 * 1024 * 1024 * 1024)),
)

_episodes_cache: Dict[str, Dict] = {}
_episode_refresh_tasks: Dict[str, asyncio.Task] = {}

def _load_persistent_cache() -> Dict:
    if CACHE_FILE.exists():
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def _save_persistent_cache(cache_data: Dict):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache_data, f, ensure_ascii=False, indent=2)
    except (OSError, TypeError) as exc:
        logger.warning("持久化剧集缓存失败: %s", exc)

_episodes_cache.update(_load_persistent_cache())


# ── 路由 ──

@router.get("/health")
async def health_check() -> Dict[str, str]:
    return {"status": "healthy", "service": "read-podcast"}


@api_router.get("/transcription/status")
async def transcription_status() -> Dict:
    from modules.transcriber import describe_transcriber

    return describe_transcriber(settings.TRANSCRIPTION_CONFIG)

@api_router.get("/subscriptions")
async def get_subscriptions() -> List[Dict]:
    return settings.PODCASTS

def _podcast_min_duration(podcast_name: str) -> int:
    podcast_cfg = settings.get_podcast_config(podcast_name) or {}
    return max(0, int(podcast_cfg.get("filter", {}).get("min_duration_seconds", 0)))


def _fetch_episodes_sync(
    podcast_name: str,
    rss_url: str,
    limit: int = 9999,
    min_duration_seconds: int = 0,
) -> List[Dict]:
    podcast_cfg = settings.get_podcast_config(podcast_name) or {}
    parser = RSSParser(
        rss_url=rss_url,
        name=podcast_name,
        insecure_tls=podcast_cfg.get("insecure_tls", False),
    )
    episodes = parser.fetch_episodes(
        limit=limit,
        min_duration_seconds=min_duration_seconds,
    )
    result = []
    for ep in episodes:
        result.append({
            "title": ep.get("title", ""),
            "published": ep.get("published", ""),
            "duration": ep.get("duration", ""),
            "duration_seconds": ep.get("duration_seconds", 0),
            "audio_url": ep.get("audio_url", ""),
            "link": ep.get("link", ""),
            "summary": ep.get("summary", ""),
        })
    return result


async def refresh_episodes_cache(podcast_name: str, rss_url: str) -> List[Dict]:
    try:
        min_duration = _podcast_min_duration(podcast_name)
        result = await asyncio.to_thread(
            _fetch_episodes_sync,
            podcast_name,
            rss_url,
            9999,
            min_duration,
        )
        if result:
            _episodes_cache[podcast_name] = {
                "data": result,
                "ts": time.time(),
                "complete": True,
                "min_duration": min_duration,
            }
            await asyncio.to_thread(_save_persistent_cache, _episodes_cache)
        return result
    except Exception as exc:
        logger.warning("后台刷新剧集缓存失败 [%s]: %s", podcast_name, exc)
        return _episodes_cache.get(podcast_name, {}).get("data", [])


def _schedule_episode_refresh(podcast_name: str, rss_url: str) -> asyncio.Task:
    existing = _episode_refresh_tasks.get(podcast_name)
    if existing and not existing.done():
        return existing

    task = asyncio.create_task(refresh_episodes_cache(podcast_name, rss_url))
    _episode_refresh_tasks[podcast_name] = task

    def _cleanup(completed: asyncio.Task) -> None:
        _episode_refresh_tasks.pop(podcast_name, None)
        if not completed.cancelled() and completed.exception():
            logger.warning("后台补齐剧集缓存失败 [%s]: %s", podcast_name, completed.exception())

    task.add_done_callback(_cleanup)
    return task


@api_router.get("/episodes")
async def get_episodes(
    podcast_name: str,
    response: Response,
    limit: int = 10,
    force: bool = False,
) -> List[Dict]:
    podcast_cfg = settings.get_podcast_config(podcast_name)
    if not podcast_cfg:
        raise HTTPException(status_code=404, detail=f"Podcast '{podcast_name}' not found in config.")

    rss_url = podcast_cfg.get("rss_url") or podcast_cfg.get("url", "")
    if not rss_url:
        raise HTTPException(status_code=400, detail=f"Podcast '{podcast_name}' has no rss_url configured.")

    now = time.time()
    min_duration = _podcast_min_duration(podcast_name)
    cached = _episodes_cache.get(podcast_name)
    if cached and cached.get("min_duration") != min_duration:
        _episodes_cache.pop(podcast_name, None)
        cached = None
    cache_complete = bool(cached and cached.get("complete", True))

    def _set_cache_state(state: str) -> None:
        response.headers["X-Read-Podcast-Cache-State"] = state
        response.headers["X-Podcast2MD-Cache-State"] = state

    # SWR (Stale-While-Revalidate) 模式：
    # 1. 存在历史缓存且非强制刷新：
    if cached and not force:
        data = cached["data"]
        if not cache_complete:
            refresh_task = _schedule_episode_refresh(podcast_name, rss_url)
            if limit <= 0:
                await refresh_task
                refreshed = _episodes_cache.get(podcast_name)
                if refreshed and refreshed.get("complete"):
                    _set_cache_state("complete")
                    return refreshed["data"]
            _set_cache_state("warming")
            return data if limit <= 0 else data[:limit]
        # 如果缓存已过 TTL，触发后台 SWR 异步刷新，主接口瞬间返回历史缓存
        if (now - cached["ts"]) >= CACHE_TTL_SECONDS:
            _schedule_episode_refresh(podcast_name, rss_url)
            _set_cache_state("stale")
        else:
            _set_cache_state("complete")
        return data if limit <= 0 else data[:limit]

    # 2. 强制刷新必须拿到完整列表。
    if force:
        try:
            result = await refresh_episodes_cache(podcast_name, rss_url)
            _set_cache_state("complete")
            return result if limit <= 0 else result[:limit]
        except Exception as exc:
            if cached:
                logger.warning("拉取剧集失败，自动回退历史缓存 [%s]: %s", podcast_name, exc)
                data = cached["data"]
                _set_cache_state("stale")
                return data if limit <= 0 else data[:limit]
            logger.exception("抓取剧集失败 [%s]", podcast_name)
            raise HTTPException(status_code=500, detail="抓取剧集失败")

    # 3. 首次打开时只同步解析首屏，完整 RSS 在后台补齐，避免点击被全量历史卡住。
    try:
        result = await asyncio.to_thread(
            _fetch_episodes_sync,
            podcast_name,
            rss_url,
            EPISODE_PREVIEW_LIMIT,
            min_duration,
        )
        if result:
            _episodes_cache[podcast_name] = {
                "data": result,
                "ts": time.time(),
                "complete": False,
                "min_duration": min_duration,
            }
            await asyncio.to_thread(_save_persistent_cache, _episodes_cache)
            _schedule_episode_refresh(podcast_name, rss_url)
        _set_cache_state("warming")
        return result if limit <= 0 else result[:limit]
    except Exception as exc:
        if cached:
            logger.warning("拉取剧集失败，自动回退历史缓存 [%s]: %s", podcast_name, exc)
            data = cached["data"]
            return data if limit <= 0 else data[:limit]
        logger.exception("抓取剧集失败 [%s]", podcast_name)
        raise HTTPException(status_code=500, detail="抓取剧集失败")


@api_router.get("/search/podcast")
async def search_podcast(q: str) -> List[Dict]:
    q_clean = q.strip() if q else ""
    if not q_clean:
        return []

    results = []

    # 1. 如果输入为直连 RSS 链接 (http:// 或 https://)
    if q_clean.startswith("http://") or q_clean.startswith("https://"):
        try:
            validate_public_url(q_clean)
            parser = RSSParser(rss_url=q_clean, name="DirectRSS")
            eps = await asyncio.to_thread(parser.fetch_episodes, limit=3)
            if eps:
                results.append({
                    "name": eps[0].get("podcast_name", "Direct RSS"),
                    "artist": "Direct RSS",
                    "rss_url": q_clean,
                    "image": "",
                    "genre": "Podcast",
                    "track_count": len(eps),
                })
        except Exception as e:
            logger.debug("解析 Direct RSS URL 失败: %s", e)

    # 2. 调用 iTunes API 检索
    try:
        url = "https://itunes.apple.com/search"
        params = {"term": q_clean, "entity": "podcast", "limit": 10, "lang": "zh_cn"}
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(url, params=params)
            if resp.status_code == 200:
                data = resp.json()
                for r in data.get("results", [])[:10]:
                    feed_url = r.get("feedUrl", "")
                    if not feed_url or any(item["rss_url"] == feed_url for item in results):
                        continue
                    results.append({
                        "name": r.get("collectionName", ""),
                        "artist": r.get("artistName", ""),
                        "rss_url": feed_url,
                        "image": r.get("artworkUrl100", r.get("artworkUrl60", "")),
                        "genre": r.get("primaryGenreName", ""),
                        "track_count": r.get("trackCount", 0),
                    })
    except Exception as e:
        logger.warning("iTunes 搜索 API 调用失败: %s", e)

    return results


async def _mutate_podcasts(mutate: Callable[[list], list]) -> list:
    async with _config_lock:
        config_path = settings.CONFIG_PATH
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                raw = yaml.safe_load(f) or {}
            service_config = raw.get("read-podcast", raw.get("podcast2md", raw))
            podcasts = service_config.get("podcasts", [])
            new_podcasts = mutate(list(podcasts))
            service_config["podcasts"] = new_podcasts
            with open(config_path, "w", encoding="utf-8") as f:
                yaml.dump(raw, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
            settings.PODCASTS = new_podcasts
            return new_podcasts
        except Exception as exc:
            logger.exception("写入订阅配置失败")
            raise HTTPException(status_code=500, detail="写入订阅配置失败") from exc


@api_router.post("/subscriptions", status_code=201)
async def add_subscription(body: AddPodcastRequest) -> Dict:
    name = body.name.strip()
    rss_url = body.rss_url.strip()
    if not name or not rss_url:
        raise HTTPException(status_code=400, detail="name 和 rss_url 均为必填项。")
    try:
        validate_public_url(rss_url)
    except UnsafeUrlError as exc:
        raise HTTPException(status_code=400, detail=f"RSS URL 不安全：{exc}") from exc
    if settings.get_podcast_config(name):
        raise HTTPException(status_code=409, detail=f"节目 '{name}' 已存在于订阅列表中。")

    loop = asyncio.get_event_loop()
    parser = RSSParser(rss_url=rss_url, name=name)

    def _validate():
        eps = parser.fetch_episodes(limit=3)
        return len(eps) > 0

    try:
        is_valid = await asyncio.wait_for(loop.run_in_executor(None, _validate), timeout=20.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408, detail="RSS 验证超时，请检查 URL 是否可访问。")

    if not is_valid:
        raise HTTPException(status_code=400, detail="RSS URL 无效或无法解析出任何期数，请检查链接是否正确。")

    await _mutate_podcasts(lambda podcasts: [*podcasts, {"name": name, "rss_url": rss_url}])

    # 新添加订阅自动预热剧集缓存
    bg_task = asyncio.create_task(refresh_episodes_cache(name, rss_url))
    _background_tasks.add(bg_task)
    bg_task.add_done_callback(_background_tasks.discard)

    return {"status": "ok", "message": f"节目 '{name}' 已成功添加。"}


@api_router.delete("/subscriptions/{name}")
async def delete_subscription(name: str) -> Dict:
    target_name = name.strip()
    if not settings.get_podcast_config(target_name):
        raise HTTPException(status_code=404, detail=f"节目 '{target_name}' 不存在于订阅列表中。")

    await _mutate_podcasts(lambda podcasts: [p for p in podcasts if p.get("name") != target_name])

    # 清理已被删除播客的内存与持久化缓存
    _episodes_cache.pop(target_name, None)
    await asyncio.to_thread(_save_persistent_cache, _episodes_cache)

    return {"status": "ok", "message": f"节目 '{target_name}' 已成功删除。"}


@api_router.post("/tasks")
async def create_task(
    body: CreateTaskRequest = None,
    podcast_name: str = None,
    episode_title: str = None,
    force: bool = False,
) -> Dict[str, str]:
    pn = podcast_name
    et = episode_title
    rerun = force
    if body:
        pn = body.podcast_name
        et = body.episode_title
        rerun = body.force
    if not pn or not et:
        raise HTTPException(status_code=400, detail="podcast_name 和 episode_title 均为必填项")
    try:
        task_id = await create_and_start_task(pn, et, force=rerun)
    except DuplicateTaskError as exc:
        # 同一节目已在处理中：回传既有任务，前端据此复用而非重复排队。
        return {"task_id": exc.task_id, "status": "existing"}
    except AlreadyProcessedError:
        raise HTTPException(
            status_code=409,
            detail="该节目已转录完成，如需重做请点击「重新转录」。",
        )
    return {"task_id": task_id, "status": "created"}


@api_router.delete("/tasks/{task_id}")
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


@api_router.post("/tasks/{task_id}/retry")
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


@api_router.post("/tasks/custom")
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

    workspace_dir = READ_PODCAST_ROOT / "workspace"
    resolved_audio = workspace_dir / "uploads" / filename
    resolved_output = workspace_dir / "custom_outputs"
    resolved_output.mkdir(parents=True, exist_ok=True)

    if not resolved_audio.exists():
        raise HTTPException(status_code=400, detail="音频文件不存在，请重新上传。")

    task_id = await create_and_start_custom_task(str(resolved_audio), str(resolved_output), custom_prompt)
    return {"task_id": task_id}


@api_router.get("/tasks")
async def get_all_tasks(limit: int = Query(20, ge=1, le=200)) -> List[PublicTask]:
    return [_public_task(task) for task in await list_tasks(limit)]


@api_router.get("/tasks/completed-keys")
async def get_completed_task_keys() -> List[Dict[str, str]]:
    return await list_completed_keys()


@api_router.get("/tasks/stream")
async def stream_all_task_logs():
    return StreamingResponse(
        notifier.subscribe(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@api_router.get("/tasks/{task_id}")
async def get_task_status(task_id: str) -> PublicTask:
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")
    return _public_task(task)


@api_router.get("/tasks/{task_id}/stream")
async def stream_task_logs(task_id: str):
    return StreamingResponse(
        notifier.subscribe(task_id),
        media_type="text/event-stream"
    )


def _read_task_output_text(task: Task) -> tuple[Path, str]:
    """读取任务输出文本文件；沿用与 content 接口一致的路径与类型校验。"""
    if not task.output_path:
        raise HTTPException(status_code=404, detail="输出文件尚未生成或已被删除")
    output_file = Path(task.output_path)
    if not output_file.exists():
        raise HTTPException(status_code=404, detail="输出文件尚未生成或已被删除")
    if output_file.suffix.lower() not in ALLOWED_TEXT_OUTPUT_EXTS:
        raise HTTPException(status_code=415, detail="不支持读取非文本输出文件")
    try:
        return output_file, output_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise HTTPException(status_code=500, detail="读取输出文件失败") from exc


@api_router.get("/tasks/{task_id}/content")
async def get_task_content(task_id: str) -> Dict[str, str]:
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")

    output_file, content = _read_task_output_text(task)

    return {
        "task_id": task_id,
        "title": task.episode_title or output_file.name,
        "filename": output_file.name,
        "content": content,
    }


@api_router.get("/tasks/{task_id}/download")
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


@api_router.post("/upload/audio")
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


@api_router.get("/prompt-templates")
async def get_prompt_templates() -> List[Dict]:
    return settings.PROMPT_TEMPLATES or []


# ── AI 阅读助手（百科查询 + 文字稿问答）──
# 复用 refiner 段的 OpenAI 兼容服务商配置与 REFINER_API_KEY，不引入新的凭据来源。

@api_router.get("/assistant/status")
async def assistant_status() -> Dict:
    """助手是否可用，供前端优雅降级（未配置 AI 时隐藏入口）。"""
    return {"available": assistant_available(settings.REFINER_CONFIG)}


@api_router.post("/assistant/lookup")
async def assistant_lookup(body: LookupRequest) -> Dict[str, str]:
    """百科查询：解释文字稿中出现的概念、人物、机构、术语或事件。"""
    term = body.term.strip()
    if not term:
        raise HTTPException(status_code=400, detail="term 不能为空")

    system = (
        "你是一位百科式讲解助手，为正在阅读播客文字稿的读者解释其中出现的概念、人物、"
        "机构、术语或事件。用简体中文，给出准确、克制、通俗的解释，控制在 120 字以内。"
        "若为多义词，结合读者提供的上下文选择最贴切的义项。不要编造不确定的事实，"
        "不确定时明确说明。直接输出解释，不要寒暄或复述问题。"
    )
    user = f"需要解释的词条：{term}"
    context = body.context.strip()
    if context:
        user += f"\n\n它出现的上下文（节选）：\n{context[:2000]}"

    try:
        explanation = await asyncio.to_thread(
            chat_completion,
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            settings.REFINER_CONFIG,
            max_tokens=400,
            temperature=0.3,
        )
    except AssistantError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {"term": term, "explanation": explanation}


@api_router.post("/tasks/{task_id}/chat")
async def chat_with_transcript(task_id: str, body: ChatRequest) -> Dict:
    """针对某份已完成文字稿的问答，回答严格基于文字稿内容。"""
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")

    _output_file, content = _read_task_output_text(task)
    transcript = strip_leading_frontmatter(content).strip()
    if not transcript:
        raise HTTPException(status_code=422, detail="文字稿为空，无法问答")

    truncated = len(transcript) > ASSISTANT_CONTEXT_CHAR_BUDGET
    context_text = transcript[:ASSISTANT_CONTEXT_CHAR_BUDGET]
    title = task.episode_title or "本期节目"

    system = (
        f"你是这份播客文字稿的阅读助手。下面三引号内是《{title}》的文字稿"
        + ("（因过长已截断，仅含前一部分）" if truncated else "")
        + "。请仅依据文字稿内容回答读者问题，用简体中文，准确、简洁、有条理。"
        "文字稿中找不到答案时如实说明“文字稿里没有提到”，不要编造或引入外部信息。\n\n"
        f'"""\n{context_text}\n"""'
    )
    messages: List[Dict[str, str]] = [{"role": "system", "content": system}]
    for msg in body.history[-ASSISTANT_MAX_HISTORY:]:
        messages.append({"role": msg.role, "content": msg.content.strip()})
    messages.append({"role": "user", "content": body.question.strip()})

    try:
        answer = await asyncio.to_thread(
            chat_completion,
            messages,
            settings.REFINER_CONFIG,
            max_tokens=1200,
            temperature=0.4,
        )
    except AssistantError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {"task_id": task_id, "answer": answer, "context_truncated": truncated}
