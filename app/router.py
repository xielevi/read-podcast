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
from typing import Callable, Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException, UploadFile, File, Query, Request, Response
from fastapi.responses import StreamingResponse, FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from app.models.task import Task, TaskStatus
from app.database import (
    delete_task,
    get_task,
    list_completed_keys,
    list_read_keys,
    list_successful_tasks,
    list_tasks,
    set_episode_read,
)
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
from modules.connectors import (
    ConnectorError,
    available_connectors,
    find_connector,
    send_document,
)
from modules.connectors import test_connector as precheck_connector
from modules.formatter import strip_leading_frontmatter
from modules.library_qa import EpisodeDoc, build_library_context
from modules.oauth_integrations import (
    OAuthIntegrationError,
    begin_authorization,
    cancel_authorization,
    complete_authorization,
    effective_connectors,
    integration_status,
    integration_statuses,
    save_app_credentials,
)
from modules.refiner import AssistantError, assistant_available, chat_completion
from modules.rss_parser import RSSParser
from modules.network_security import UnsafeUrlError, validate_public_url
from modules.user_settings import (
    SettingsError,
    SettingsProbeError,
    apply_settings,
    describe_settings,
    probe_refiner,
    probe_transcription,
)
from modules.utils import extract_frontmatter
from modules.wikipedia import (
    DEFAULT_FALLBACK_LANG,
    DEFAULT_LANG,
    MAX_CONCEPTS,
    MIN_CONCEPTS,
    WikipediaError,
    collect_concepts,
)

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
    image: str = Field(default="", max_length=2048)

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

class LibraryChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: List[ChatMessage] = Field(default_factory=list)

class ExportRequest(BaseModel):
    connector: str = Field(min_length=1, max_length=200)
    # manuscript：推送整篇成稿；summary：推送 AI 提炼的知识条目
    mode: str = Field(default="manuscript", pattern="^(manuscript|summary)$")

class ConceptsRequest(BaseModel):
    """关键概念抽取；limit 缺省时用配置里的值。"""
    limit: Optional[int] = Field(default=None, ge=MIN_CONCEPTS, le=MAX_CONCEPTS)
    refresh: bool = False

class SettingsUpdateRequest(BaseModel):
    """普通配置与机密分开提交；机密缺省表示不改动，空串表示清除。"""
    values: Dict[str, str] = Field(default_factory=dict)
    secrets: Dict[str, str] = Field(default_factory=dict)

class SettingsTestRequest(BaseModel):
    target: str = Field(pattern="^(refiner|transcription)$")

class OAuthAppCredentialsRequest(BaseModel):
    client_id: str = Field(min_length=1, max_length=2048)
    client_secret: str = Field(min_length=1, max_length=2048)

class OAuthAuthorizeRequest(BaseModel):
    redirect_uri: str = Field(min_length=1, max_length=2048)

class EpisodeReadStateRequest(BaseModel):
    podcast_name: str = Field(min_length=1, max_length=500)
    episode_title: str = Field(min_length=1, max_length=1000)
    read: bool

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
# 跨节目问答检索的语料上限：最多纳入多少期已完成稿件。
LIBRARY_CORPUS_LIMIT = 60
# 单期稿件读入的字符上限，避免超长稿件拖慢检索。
LIBRARY_DOC_CHAR_CAP = 40000
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


# 允许代理的封面图类型；上游返回其他类型时拒绝，防止把代理当成任意抓取器。
_ALLOWED_IMAGE_TYPES = {
    "image/jpeg": "image/jpeg",
    "image/jpg": "image/jpeg",
    "image/png": "image/png",
    "image/webp": "image/webp",
    "image/gif": "image/gif",
    "image/avif": "image/avif",
}
MAX_ARTWORK_BYTES = 5 * 1024 * 1024


def _safe_artwork_url(url: str) -> str:
    """仅接受解析到公网地址的 http(s) 封面图 URL，否则返回空串。"""
    candidate = str(url or "").strip()
    if not candidate:
        return ""
    try:
        validate_public_url(candidate)
    except UnsafeUrlError:
        return ""
    return candidate


@api_router.get("/artwork")
async def artwork_proxy(url: str = Query(..., max_length=2048)):
    """SSRF 安全的封面图代理：校验公网地址、限制体积与类型，避免浏览器直连第三方 CDN。"""
    from modules.network_security import read_limited, safe_get

    if not _safe_artwork_url(url):
        raise HTTPException(status_code=400, detail="封面图地址不合法或不安全")

    def _fetch() -> tuple[bytes, str]:
        response = safe_get(url, timeout=10, stream=True)
        try:
            response.raise_for_status()
            content_type = (response.headers.get("Content-Type", "") or "").split(";")[0].strip().lower()
            if content_type not in _ALLOWED_IMAGE_TYPES:
                raise HTTPException(status_code=415, detail="不支持的封面图类型")
            data = read_limited(response, MAX_ARTWORK_BYTES)
            return data, _ALLOWED_IMAGE_TYPES[content_type]
        finally:
            response.close()

    try:
        data, media_type = await asyncio.to_thread(_fetch)
    except HTTPException:
        raise
    except Exception as exc:
        logger.debug("封面图代理失败: %s", exc)
        raise HTTPException(status_code=502, detail="封面图获取失败")

    return Response(
        content=data,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )

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

    # 封面图：优先用调用方（搜索结果）提供的，其次回退 RSS 频道封面；仅接受公网 http(s)。
    image = _safe_artwork_url(body.image.strip() or parser.channel_image)
    entry = {"name": name, "rss_url": rss_url}
    if image:
        entry["image"] = image
    await _mutate_podcasts(lambda podcasts: [*podcasts, entry])

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


@api_router.get("/episodes/read")
async def get_read_episodes() -> List[str]:
    """已读单集的 `播客名::标题` key 列表，服务端持久化，不依赖浏览器本地存储。"""
    return await list_read_keys()


@api_router.put("/episodes/read")
async def put_read_episode(body: EpisodeReadStateRequest) -> Dict:
    await set_episode_read(body.podcast_name.strip(), body.episode_title.strip(), body.read)
    return {"ok": True}


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


def _collect_library_docs(tasks: List[Task]) -> List[EpisodeDoc]:
    """读取已完成稿件文本，构建跨节目问答的语料（有界，跳过缺失/非文本文件）。"""
    docs: List[EpisodeDoc] = []
    for task in tasks:
        if not task.output_path:
            continue
        output_file = Path(task.output_path)
        if not output_file.exists() or output_file.suffix.lower() not in ALLOWED_TEXT_OUTPUT_EXTS:
            continue
        try:
            raw = output_file.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        text = strip_leading_frontmatter(raw).strip()
        if not text:
            continue
        docs.append(
            EpisodeDoc(
                task_id=task.id,
                title=task.episode_title or output_file.stem,
                podcast=task.podcast_name or "",
                text=text[:LIBRARY_DOC_CHAR_CAP],
                created_at=task.created_at.isoformat() if task.created_at else "",
            )
        )
    return docs


@api_router.post("/assistant/library/chat")
async def chat_with_library(body: LibraryChatRequest) -> Dict:
    """跨多期播客问答：从最近有界稿件集中检索相关节目并标注来源。"""
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question 不能为空")

    tasks = await list_successful_tasks(LIBRARY_CORPUS_LIMIT)
    docs = await asyncio.to_thread(_collect_library_docs, tasks)
    if not docs:
        raise HTTPException(status_code=404, detail="稿件库还没有已完成的稿件，先转录几期再来提问吧。")

    selection = await asyncio.to_thread(build_library_context, question, docs)
    if not selection.context:
        raise HTTPException(status_code=422, detail="没有检索到可用于回答的稿件内容")

    system = (
        "你是一位跨多期播客的知识助手。下面用【序号】分隔的是从用户稿件库中检索到的若干期"
        "节目的相关片段。请综合这些片段回答问题，用简体中文，条理清晰。"
        "涉及不同节目的观点时，注明它们各自来自哪一期（用节目标题指代），"
        "并在合适时点出不同嘉宾/节目之间的共识与分歧。"
        "只依据给定片段作答，片段中没有的内容如实说明“稿件库里没有相关内容”，不要编造或引入外部信息。\n\n"
        f"{selection.context}"
    )
    messages: List[Dict[str, str]] = [{"role": "system", "content": system}]
    for msg in body.history[-ASSISTANT_MAX_HISTORY:]:
        messages.append({"role": msg.role, "content": msg.content.strip()})
    messages.append({"role": "user", "content": question})

    try:
        answer = await asyncio.to_thread(
            chat_completion,
            messages,
            settings.REFINER_CONFIG,
            max_tokens=1500,
            temperature=0.4,
        )
    except AssistantError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {
        "answer": answer,
        "sources": selection.sources,
        "episodes_searched": len(docs),
        "context_truncated": selection.truncated,
    }


# ── 关键概念 → 维基百科 ──
# AI 只负责从文字稿里提名候选词，链接一律由维基百科 API 核对后生成，避免模型编造词条地址。

# 抽取一次要过一遍 AI + 若干次维基百科查询，成本不低；同一篇稿子的结果按输出文件
# 的修改时间缓存，正文没变就直接复用（前端也不必担心重复打开阅读页触发重算）。
_concepts_cache: Dict[str, Dict] = {}
_CONCEPTS_CACHE_MAX = 128


def _wikipedia_config() -> Dict:
    raw = settings.RUNTIME_CONFIG.get("wikipedia") if isinstance(settings.RUNTIME_CONFIG, dict) else None
    return raw if isinstance(raw, dict) else {}


@api_router.post("/tasks/{task_id}/concepts")
async def get_task_concepts(task_id: str, body: ConceptsRequest) -> Dict:
    """抽取本篇文字稿的关键概念，并给出经过核对的维基百科链接。"""
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")

    output_file, content = _read_task_output_text(task)
    transcript = strip_leading_frontmatter(content).strip()
    if not transcript:
        raise HTTPException(status_code=422, detail="文字稿为空，无法抽取关键概念")

    config = _wikipedia_config()
    limit = body.limit or int(config.get("limit", MAX_CONCEPTS) or MAX_CONCEPTS)
    limit = max(MIN_CONCEPTS, min(limit, MAX_CONCEPTS))

    try:
        mtime = output_file.stat().st_mtime_ns
    except OSError:
        mtime = 0
    cache_key = f"{task_id}:{mtime}:{limit}"
    if not body.refresh:
        cached = _concepts_cache.get(cache_key)
        if cached:
            return {**cached, "cached": True}

    try:
        result = await asyncio.to_thread(
            collect_concepts,
            task.episode_title or output_file.stem,
            task.podcast_name or "",
            transcript,
            settings.REFINER_CONFIG,
            lang=str(config.get("lang", DEFAULT_LANG) or DEFAULT_LANG),
            fallback_lang=str(config.get("fallback_lang", DEFAULT_FALLBACK_LANG) or ""),
            limit=limit,
        )
    except WikipediaError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    payload = {"task_id": task_id, **result}
    if len(_concepts_cache) >= _CONCEPTS_CACHE_MAX:
        _concepts_cache.clear()
    _concepts_cache[cache_key] = payload
    return {**payload, "cached": False}


# ── 文件连接器（把成稿推送到外部文档/群机器人）──

def _connectors() -> List[Dict]:
    return effective_connectors(settings.CONNECTORS)


def _request_origin(request: Request) -> str:
    return f"{request.url.scheme}://{request.url.netloc}"


def _oauth_callback_html(provider: str, ok: bool, detail: str, origin: str) -> HTMLResponse:
    payload = json.dumps(
        {"type": "read-podcast-oauth", "provider": provider, "ok": ok, "detail": detail},
        ensure_ascii=False,
    ).replace("<", "\\u003c").replace(">", "\\u003e")
    target_origin = json.dumps(origin).replace("<", "\\u003c").replace(">", "\\u003e")
    title = "账号已连接" if ok else "账号连接失败"
    body = (
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
        f"<title>{title}</title></head><body><p>{title}</p><script>"
        f"if(window.opener){{window.opener.postMessage({payload},{target_origin});}}"
        "window.close();</script></body></html>"
    )
    return HTMLResponse(body, headers={"Cache-Control": "no-store"})


@api_router.get("/integrations")
async def get_integrations() -> List[Dict]:
    """返回 OAuth 应用与账号连接状态，不含任何凭据或令牌。"""
    return integration_statuses()


@api_router.put("/integrations/{provider}/app")
async def put_integration_app(provider: str, body: OAuthAppCredentialsRequest) -> Dict:
    """保存开发者应用凭据；机密只落本机 secrets.env。"""
    try:
        return await asyncio.to_thread(
            save_app_credentials,
            provider,
            body.client_id,
            body.client_secret,
        )
    except OAuthIntegrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@api_router.post("/integrations/{provider}/authorize")
async def authorize_integration(
    provider: str,
    body: OAuthAuthorizeRequest,
    request: Request,
) -> Dict:
    """创建一次性 state 并返回第三方授权地址。"""
    try:
        return begin_authorization(provider, body.redirect_uri, _request_origin(request))
    except OAuthIntegrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@api_router.get("/integrations/{provider}/callback")
async def integration_callback(
    provider: str,
    request: Request,
    state: str = "",
    code: str = "",
    error: str = "",
) -> HTMLResponse:
    """校验 state、交换令牌并通知同源登录窗口。"""
    origin = _request_origin(request)
    try:
        if error:
            pending = cancel_authorization(provider, state)
            origin = pending["origin"]
            raise OAuthIntegrationError("用户取消了授权")
        result = await asyncio.to_thread(complete_authorization, provider, code, state)
        origin = str(result.pop("origin"))
        return _oauth_callback_html(provider, True, "账号已连接", origin)
    except OAuthIntegrationError as exc:
        return _oauth_callback_html(provider, False, str(exc), origin)


@api_router.get("/connectors")
async def get_connectors() -> List[Dict]:
    """可用连接器清单（不含 Webhook 地址），供前端渲染导出入口。"""
    return available_connectors(_connectors())


@api_router.post("/tasks/{task_id}/export")
async def export_task(task_id: str, body: ExportRequest) -> Dict:
    """把某份成稿推送到指定连接器目标。"""
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")

    connector = find_connector(_connectors(), body.connector.strip())
    if not connector:
        raise HTTPException(status_code=404, detail=f"连接器 '{body.connector}' 不存在")

    _output_file, content = _read_task_output_text(task)
    parsed_frontmatter = extract_frontmatter(content.lstrip())[0]
    frontmatter = parsed_frontmatter if isinstance(parsed_frontmatter, dict) else {}
    source_link = str(frontmatter.get("source_link") or frontmatter.get("link") or "")
    title = task.episode_title or _output_file.stem
    transcript = strip_leading_frontmatter(content).strip()

    if body.mode == "summary":
        markdown = await _build_knowledge_entry(title, task.podcast_name or "", transcript)
    else:
        markdown = transcript

    doc = {
        "title": title,
        "podcast": task.podcast_name or "",
        "markdown": markdown,
        "source_link": source_link,
    }

    try:
        result = await asyncio.to_thread(send_document, connector, doc)
    except ConnectorError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {"task_id": task_id, "status": "sent", "mode": body.mode, **result}


async def _build_knowledge_entry(title: str, podcast: str, transcript: str) -> str:
    """用 AI 从文字稿提炼可沉淀的知识条目（核心观点/案例/知识点/选题）。"""
    if not transcript:
        raise HTTPException(status_code=422, detail="文字稿为空，无法生成知识条目")
    context = transcript[:ASSISTANT_CONTEXT_CHAR_BUDGET]
    truncated_note = "（文字稿较长，仅据前一部分提炼）\n\n" if len(transcript) > ASSISTANT_CONTEXT_CHAR_BUDGET else ""
    system = (
        "你是知识管理助手，负责把播客文字稿沉淀成可长期复用的知识条目。"
        "只依据给定文字稿，用简体中文输出结构化 Markdown，包含这些小节："
        "## 核心观点、## 关键案例、## 可沉淀的知识点、## 可延伸选题。"
        "每条简明扼要、忠于原文，文字稿没有提到的不要编造；无对应内容的小节可写“（本期未涉及）”。"
        "不要输出正文之外的说明。"
    )
    header = f"《{title}》" + (f"（{podcast}）" if podcast else "")
    user = f"{truncated_note}节目：{header}\n\n文字稿：\n\"\"\"\n{context}\n\"\"\""
    try:
        entry = await asyncio.to_thread(
            chat_completion,
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            settings.REFINER_CONFIG,
            max_tokens=1600,
            temperature=0.3,
        )
    except AssistantError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return f"# {header} · 知识条目\n\n{entry}"


@api_router.post("/connectors/{name}/test")
async def test_connector_endpoint(name: str) -> Dict:
    """预检连接器凭据/可达性，不产生正式内容。"""
    connector = find_connector(_connectors(), name.strip())
    if not connector:
        raise HTTPException(status_code=404, detail=f"连接器 '{name}' 不存在")
    try:
        return await asyncio.to_thread(precheck_connector, connector)
    except ConnectorError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# ── 个人配置面板（WebUI 直接编辑服务商地址、模型、路径与机密）──

@api_router.get("/settings")
async def get_settings() -> Dict:
    """面板字段与当前取值；机密只回传「是否已配置」，绝不回传内容。"""
    return await asyncio.to_thread(describe_settings)


@api_router.put("/settings")
async def update_settings(body: SettingsUpdateRequest) -> Dict:
    """普通配置写入 config.yaml，机密写入 config/secrets.env，随后热重载。"""
    async with _config_lock:
        try:
            return await asyncio.to_thread(apply_settings, body.values, body.secrets)
        except SettingsError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@api_router.post("/settings/test")
async def test_settings(body: SettingsTestRequest) -> Dict:
    """按当前配置做一次只读预检，不产生正式内容，也不回传服务地址。"""
    probe = probe_refiner if body.target == "refiner" else probe_transcription
    try:
        return await asyncio.to_thread(probe)
    except SettingsProbeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
