from __future__ import annotations

import asyncio
import logging
import uuid
from concurrent.futures import TimeoutError as FuturesTimeoutError
from datetime import datetime
from pathlib import Path
from typing import Awaitable, Callable

from app.database import get_task, has_successful_task, save_task, update_task
from app.models.task import Task, TaskStatus
from app.sse import notifier
from modules.config import settings
from modules.pipeline import PodcastPipeline


logger = logging.getLogger(__name__)
P2M_ROOT = Path(__file__).parent.parent.absolute()

DOWNLOAD_CONCURRENCY = max(1, int(settings.RUNTIME_CONFIG.get("download_concurrency", 2)))
REFINE_CONCURRENCY = max(1, int(settings.RUNTIME_CONFIG.get("refine_concurrency", 2)))

# 下载和精修可与其他任务重叠；宿主机 Whisper 保持单请求入口。
_download_slots = asyncio.Semaphore(DOWNLOAD_CONCURRENCY)
_whisper_lock = asyncio.Lock()
_refine_slots = asyncio.Semaphore(REFINE_CONCURRENCY)
_background_tasks: set[asyncio.Task] = set()

# task_id -> 正在运行的 asyncio.Task，供取消使用。
_task_registry: dict[str, asyncio.Task] = {}
# "podcast::episode" -> task_id，用于阻止同一节目重复入队（去重）。
_active_keys: dict[str, str] = {}
# 保证「查重 + 建任务」这段临界区串行执行，杜绝双击并发穿透。
_dispatch_lock = asyncio.Lock()


class DuplicateTaskError(RuntimeError):
    """已存在同一节目的进行中任务，返回既有 task_id 而非新建。"""

    def __init__(self, task_id: str):
        super().__init__(task_id)
        self.task_id = task_id


class AlreadyProcessedError(RuntimeError):
    """节目此前已成功转录；隐式转录被拒，需显式点击「重新转录」。"""


def safe_progress_message(stage: str, message: str) -> str:
    """状态接口只返回短的业务进度，不泄露 URL、凭据或本机路径。"""
    text = str(message or "").strip()
    sensitive_markers = (
        "://",
        "/Users/",
        "/private/",
        "/var/",
        "/tmp/",
        "Bearer ",
        "token=",
        "api_key",
        "sk-",
    )
    if not text or any(marker.lower() in text.lower() for marker in sensitive_markers):
        return {
            "queued": "已加入整理流水线…",
            "resolving": "正在读取节目信息…",
            "downloading": "正在准备源音频…",
            "transcribing": "Whisper 正在转录音频…",
            "refining": "AI 正在精修转录稿…",
            "finalizing": "正在生成 Markdown…",
            "done": "声音整理完成！",
        }.get(stage, "任务正在处理…")
    return text[:300]


def _episode_key(podcast_name: str, episode_title: str) -> str:
    return f"{podcast_name}::{episode_title}"


def _register_task(task_id: str, background: asyncio.Task, key: str | None) -> None:
    """登记后台任务，并在结束时清理注册表与去重键。"""
    _task_registry[task_id] = background
    _background_tasks.add(background)
    if key:
        _active_keys[key] = task_id

    def _cleanup(_done: asyncio.Task) -> None:
        _background_tasks.discard(background)
        if _task_registry.get(task_id) is background:
            _task_registry.pop(task_id, None)
        if key and _active_keys.get(key) == task_id:
            _active_keys.pop(key, None)

    background.add_done_callback(_cleanup)


def _progress_value(stage: str, pct: int) -> int:
    bounded = max(0, min(100, pct))
    if stage in {"resolving", "downloading"}:
        return 5 + int(bounded * 0.20)
    if stage == "transcribing":
        return 25 + int(bounded * 0.45)
    if stage == "refining":
        return 70 + int(bounded * 0.25)
    return bounded


async def _publish_progress(task_id: str, stage: str, pct: int, message: str) -> None:
    progress = _progress_value(stage, pct)
    message = safe_progress_message(stage, message)
    await update_task(
        task_id,
        status=TaskStatus.RUNNING,
        stage=stage,
        progress_pct=progress,
        message=message,
    )
    await notifier.push(
        task_id,
        {
            "level": "info",
            "message": message,
            "progress": progress,
            "stage": stage,
            "status": "running",
        },
    )


def _thread_reporter(task_id: str, loop: asyncio.AbstractEventLoop):
    """把同步流水线中的阶段事件按顺序写回当前 WebUI 事件循环。"""

    def report(stage: str, pct: int, message: str) -> None:
        future = asyncio.run_coroutine_threadsafe(
            _publish_progress(task_id, stage, pct, message),
            loop,
        )
        # 进度回写只是「尽力而为」：多任务排队时事件循环可能短暂拥塞，
        # 绝不能因为一次进度推送超时就把整条转录流水线打挂。
        try:
            future.result(timeout=30)
        except FuturesTimeoutError:
            future.cancel()
            logger.warning("任务 %s 进度回写超时(stage=%s)，已跳过该次推送", task_id, stage)
        except Exception:
            logger.warning("任务 %s 进度回写失败(stage=%s)", task_id, stage, exc_info=True)

    return report


async def _mark_cancelled(task_id: str) -> None:
    logger.info("Task %s cancelled", task_id)
    task = await get_task(task_id)
    progress = task.progress_pct if task else 0
    stage = task.stage if task else "cancelled"
    await update_task(
        task_id,
        status=TaskStatus.CANCELLED,
        message="任务已取消；原音频已保留，可直接重试。",
        output_path=None,
    )
    await notifier.push(
        task_id,
        {
            "level": "error",
            "message": "任务已取消；原音频已保留，可直接重试。",
            "progress": progress,
            "stage": stage,
            "status": "cancelled",
        },
    )


async def _mark_failed(task_id: str, exc: Exception) -> None:
    logger.error("Task %s failed: %s", task_id, exc, exc_info=True)
    task = await get_task(task_id)
    stage = task.stage if task else "error"
    progress = task.progress_pct if task else 0
    message = "转录或整理未成功；原音频已保留，可直接重试。"
    await update_task(
        task_id,
        status=TaskStatus.FAILED,
        message=message,
        output_path=None,
    )
    await notifier.push(
        task_id,
        {
            "level": "error",
            "message": message,
            "progress": progress,
            "stage": stage,
            "status": "failed",
        },
    )


async def _run_stages(
    task_id: str,
    stages: list[tuple[object, str, str, Callable[[], Awaitable[None]]]],
    output_path: Callable[[], Path | None],
    success_message: str,
) -> None:
    await update_task(
        task_id,
        status=TaskStatus.PENDING,
        stage="queued",
        progress_pct=2,
        message="已加入整理流水线…",
    )
    await notifier.push(
        task_id,
        {"level": "info", "message": "已加入整理流水线…", "progress": 2, "stage": "queued", "status": "pending"},
    )
    try:
        for slot, stage, message, runner in stages:
            async with slot:
                await _publish_progress(task_id, stage, 0, message)
                await runner()

        resolved_output = output_path()
        if not resolved_output or not resolved_output.is_file():
            raise RuntimeError("流水线结束但没有生成输出文件")
        await update_task(
            task_id,
            status=TaskStatus.SUCCESS,
            stage="done",
            progress_pct=100,
            message=success_message,
            output_path=str(resolved_output),
        )
        await notifier.push(
            task_id,
            {
                "level": "done",
                "message": success_message,
                "progress": 100,
                "stage": "done",
                "status": "success",
                "output_path": str(resolved_output),
            },
        )
    except asyncio.CancelledError:
        await _mark_cancelled(task_id)
        raise
    except Exception as exc:
        await _mark_failed(task_id, exc)


async def run_pipeline(
    task_id: str,
    podcast_name: str,
    episode_title: str,
    force: bool = False,
) -> None:
    loop = asyncio.get_running_loop()
    progress = _thread_reporter(task_id, loop)
    pipeline = PodcastPipeline()
    work = None

    async def prepare() -> None:
        nonlocal work
        work = await asyncio.to_thread(
                pipeline.prepare_episode,
                podcast_name,
                episode_title,
                force=force,
                progress_callback=progress,
            )

    async def transcribe() -> None:
        nonlocal work
        work = await asyncio.to_thread(
                pipeline.transcribe,
                work,
                progress,
            )

    async def refine() -> None:
        nonlocal work
        work = await asyncio.to_thread(
                pipeline.refine,
                work,
                skip_refine=False,
                progress_callback=progress,
            )

    async def finalize() -> None:
        nonlocal work
        work = await asyncio.to_thread(pipeline.finalize, work)

    await _run_stages(
        task_id,
        [
            (_download_slots, "downloading", "正在准备节目和源音频…", prepare),
            (_whisper_lock, "transcribing", "正在等待本机 Whisper…", transcribe),
            (_refine_slots, "refining", "正在进入 AI 精修阶段…", refine),
            (_refine_slots, "finalizing", "正在生成 Markdown…", finalize),
        ],
        lambda: work.output_path if work else None,
        "✅ 声音整理完成！",
    )


async def create_and_start_task(
    podcast_name: str,
    episode_title: str,
    force: bool = False,
) -> str:
    """创建并启动一期节目的转录任务。

    去重语义：
    - 若同一节目已有进行中的任务，直接返回既有 task_id（不重复入队）。
    - 若 force=False 且该节目此前已成功转录，抛出 AlreadyProcessedError；
      需要重新转录时前端必须显式传 force=True（对应「重新转录」按钮）。
    """
    key = _episode_key(podcast_name, episode_title)
    async with _dispatch_lock:
        existing_id = _active_keys.get(key)
        if existing_id and existing_id in _task_registry:
            raise DuplicateTaskError(existing_id)

        if not force and await has_successful_task(podcast_name, episode_title):
            raise AlreadyProcessedError(episode_title)

        task_id = str(uuid.uuid4())
        task = Task(
            id=task_id,
            podcast_name=podcast_name,
            episode_title=episode_title,
            status=TaskStatus.PENDING,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        await save_task(task)
        background = asyncio.create_task(
            run_pipeline(task_id, podcast_name, episode_title, force=force)
        )
        _register_task(task_id, background, key)
    return task_id


async def cancel_task(task_id: str) -> bool:
    """取消进行中的任务；返回 True 表示已发出取消信号。

    正在执行的宿主机 Whisper 线程无法强杀，会自然跑完后被丢弃；
    但事件循环侧的任务会立即进入取消流程并释放并发槽位。
    """
    background = _task_registry.get(task_id)
    if background is None or background.done():
        return False
    background.cancel()
    return True


async def run_custom_pipeline(
    task_id: str,
    audio_path: str,
    output_dir: str,
    custom_prompt: str,
) -> None:
    loop = asyncio.get_running_loop()
    progress = _thread_reporter(task_id, loop)
    try:
        workspace_dir = (P2M_ROOT / "workspace").resolve()
        candidate = Path(audio_path)
        resolved_audio = (
            workspace_dir / "uploads" / audio_path
            if len(candidate.parts) == 1
            else candidate.expanduser().resolve()
        )
        resolved_output = Path(output_dir).expanduser().resolve()
        if not resolved_audio.is_relative_to(workspace_dir) or not resolved_output.is_relative_to(
            workspace_dir
        ):
            raise PermissionError("音频及输出路径必须位于 workspace 内")
        if not resolved_audio.is_file():
            raise FileNotFoundError(f"音频文件不存在：{resolved_audio.name}")
        resolved_output.mkdir(parents=True, exist_ok=True)
    except asyncio.CancelledError:
        await _mark_cancelled(task_id)
        raise
    except Exception as exc:
        await _mark_failed(task_id, exc)
        return

    stem = resolved_audio.stem
    cache_path = resolved_output / f"{stem}.raw.txt"
    output_path = resolved_output / f"{stem}.精修稿.md"
    raw_text = ""
    formatted_text = ""

    def transcribe_audio():
        from modules.transcriber import get_transcriber

        return get_transcriber(settings.TRANSCRIPTION_CONFIG).transcribe(
            str(resolved_audio),
            cache_path=str(cache_path),
            progress_callback=progress,
        )

    async def transcribe() -> None:
        nonlocal raw_text
        result = await asyncio.to_thread(transcribe_audio)
        if not result or not result.text.strip():
            raise RuntimeError("转录返回空结果")
        raw_text = result.text

    async def refine() -> None:
        nonlocal formatted_text
        formatted_text = raw_text
        if not custom_prompt.strip():
            return

        def refine_audio():
            from modules.refiner import get_refiner
            from modules.utils import verify_refinement_quality

            refiner = get_refiner(settings.REFINER_CONFIG)
            refined = refiner.call(custom_prompt.strip(), raw_text, progress_callback=progress)
            if not refined:
                return raw_text
            valid, _, _ = verify_refinement_quality(refined, raw_text, min_output_ratio=0.9)
            return refined if valid else raw_text

        formatted_text = await asyncio.to_thread(refine_audio)

    async def finalize() -> None:
        await asyncio.to_thread(output_path.write_text, formatted_text, encoding="utf-8")

    await _run_stages(
        task_id,
        [
            (_whisper_lock, "transcribing", "正在等待本机 Whisper…", transcribe),
            (_refine_slots, "refining", "正在通过 AI 整理稿件…", refine),
            (_refine_slots, "finalizing", "正在写入整理稿…", finalize),
        ],
        lambda: output_path,
        "✅ 整理完成！",
    )


async def create_and_start_custom_task(
    audio_path: str,
    output_dir: str,
    custom_prompt: str,
) -> str:
    task_id = str(uuid.uuid4())
    task = Task(
        id=task_id,
        podcast_name="自定义",
        episode_title=Path(audio_path).stem,
        status=TaskStatus.PENDING,
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    await save_task(task)
    background = asyncio.create_task(
        run_custom_pipeline(task_id, audio_path, output_dir, custom_prompt)
    )
    _register_task(task_id, background, None)
    return task_id
