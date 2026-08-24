"""订阅、剧集列表（SWR 缓存）、播客搜索、封面图代理与已读状态。"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Callable, Dict, List

import httpx
import yaml
from fastapi import APIRouter, HTTPException, Query, Response

from app.database import list_read_keys, set_episode_read
from app.routers._shared import config_lock
from app.schemas import AddPodcastRequest, EpisodeReadStateRequest
from modules.config import settings
from modules.network_security import UnsafeUrlError, validate_public_url
from modules.rss_parser import RSSParser

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Read Podcast"])
KEY_PAGE_SIZE = 200
KEY_PAGE_MAX = 500

# ── 路径常量与内存缓存 ──
CACHE_DIR = settings.DATA_DIR / "data"
CACHE_FILE = CACHE_DIR / "episodes_cache.json"
CACHE_TTL_SECONDS = 3600
EPISODE_PREVIEW_LIMIT = 10

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

_episodes_cache: Dict[str, Dict] = {}
_episode_refresh_tasks: Dict[str, asyncio.Task] = {}
_background_tasks: set[asyncio.Task] = set()


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


# ── 订阅 ──

@router.get("/subscriptions")
async def get_subscriptions() -> List[Dict]:
    return settings.PODCASTS


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


@router.get("/artwork")
async def artwork_proxy(url: str = Query(..., max_length=2048)):
    """SSRF 安全的封面图代理：校验公网地址、限制体积与类型，避免浏览器直连第三方 CDN。"""
    if not _safe_artwork_url(url):
        raise HTTPException(status_code=400, detail="封面图地址不合法或不安全")

    def _fetch() -> tuple[bytes, str]:
        # 局部导入：让测试可通过 monkeypatch network_security.safe_get 打桩。
        from modules.network_security import read_limited, safe_get

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


@router.get("/episodes")
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


@router.get("/search/podcast")
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
    async with config_lock:
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


@router.post("/subscriptions", status_code=201)
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

    loop = asyncio.get_running_loop()
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


@router.delete("/subscriptions/{name}")
async def delete_subscription(name: str) -> Dict:
    target_name = name.strip()
    if not settings.get_podcast_config(target_name):
        raise HTTPException(status_code=404, detail=f"节目 '{target_name}' 不存在于订阅列表中。")

    await _mutate_podcasts(lambda podcasts: [p for p in podcasts if p.get("name") != target_name])

    # 清理已被删除播客的内存与持久化缓存
    _episodes_cache.pop(target_name, None)
    await asyncio.to_thread(_save_persistent_cache, _episodes_cache)

    return {"status": "ok", "message": f"节目 '{target_name}' 已成功删除。"}


# ── 已读状态（服务端持久化，不依赖浏览器本地存储）──

@router.get("/episodes/read")
async def get_read_episodes(
    limit: int = Query(KEY_PAGE_SIZE, ge=1, le=KEY_PAGE_MAX),
    offset: int = Query(0, ge=0),
) -> Dict:
    """分页返回已读单集 key，避免一次构造无上限的数据库结果和 JSON。"""
    rows = await list_read_keys(limit=limit + 1, offset=offset)
    has_more = len(rows) > limit
    return {
        "items": rows[:limit],
        "next_offset": offset + limit if has_more else None,
    }


@router.put("/episodes/read")
async def put_read_episode(body: EpisodeReadStateRequest) -> Dict:
    await set_episode_read(body.podcast_name.strip(), body.episode_title.strip(), body.read)
    return {"ok": True}
