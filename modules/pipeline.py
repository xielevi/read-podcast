"""Podcast2MD 的单一业务流水线实现。"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from modules.config import settings
from modules.downloader import Downloader
from modules.formatter import Formatter
from modules.refiner import get_refiner, build_refine_prompt
from modules.rss_parser import RSSParser
from modules.transcriber import TranscriptionResult, get_transcriber
from modules.utils import StateManager, datetime_to_str, verify_refinement_quality


logger = logging.getLogger(__name__)
ProgressCallback = Callable[[str, int, str], None]


class PipelineError(RuntimeError):
    """流水线无法产生有效输出。"""


def refine_transcript(
    raw_text: str,
    summary: str,
    refiner_config: dict,
    progress_callback: ProgressCallback | None = None,
) -> tuple[str, bool]:
    """统一执行精修与质量门禁；失败时返回原始转录。"""
    prompt = build_refine_prompt(summary or "无官方简介", refiner_config)
    if progress_callback:
        progress_callback("refining", 5, "开始 AI 精修…")
    refined_text = get_refiner(refiner_config).call(
        prompt,
        raw_text,
        progress_callback=progress_callback,
    )
    if refined_text:
        valid, _, features = verify_refinement_quality(
            refined_text,
            raw_text,
            min_output_ratio=0.9,
        )
        if valid:
            return refined_text, True
        logger.warning("精修未通过质量门禁 (%s)，使用原始转录", ", ".join(features))
    else:
        logger.warning("精修返回空结果，使用原始转录")
    if progress_callback:
        progress_callback("refining", 100, "精修未通过，已回退原始转录")
    return raw_text, False


@dataclass
class EpisodeWork:
    podcast: dict
    episode: dict
    filename_base: str
    raw_path: Path
    audio_path: Path | None = None
    raw_text: str = ""
    transcript_text: str = ""
    refinement_success: bool = False
    output_path: Path | None = None


def build_filename_base(podcast_name: str, date_str: str, episode_title: str) -> str:
    """生成稳定且兼容历史缓存的文件名。"""
    import re

    numeric = re.match(r"^(\d+)\s+(.*)", episode_title)
    if numeric:
        return f"{date_str}_{podcast_name}_{numeric.group(1)}_{numeric.group(2).strip()}"
    volume = re.match(r"^(Vol\.\d+)\s*[｜|]\s*(.*)", episode_title)
    if volume:
        return f"{date_str}_{podcast_name}_{volume.group(1)}_{volume.group(2).strip()}"
    return f"{date_str}_{podcast_name}_{episode_title}"


class PodcastPipeline:
    """可由 WebUI 或维护脚本复用的分阶段同步流水线。"""

    def __init__(self, settings_obj=settings):
        self.settings = settings_obj
        self.state_manager = StateManager(settings_obj.STATE_FILE)
        self.transcriber = get_transcriber(settings_obj.TRANSCRIPTION_CONFIG)
        self.formatter = Formatter()

    def podcast_config(self, podcast_name: str) -> dict:
        podcast = self.settings.get_podcast_config(podcast_name)
        if not podcast or not podcast.get("enabled", True):
            raise PipelineError(f"未找到或未启用播客: {podcast_name}")
        return podcast

    def fetch_episodes(
        self,
        podcast_name: str,
        *,
        limit: int = 1,
        reverse: bool = False,
        episode_id: str | None = None,
        episode_title: str | None = None,
    ) -> list[dict]:
        podcast = self.podcast_config(podcast_name)
        parser = RSSParser(podcast["rss_url"], podcast["name"])
        return parser.fetch_episodes(
            limit=limit,
            min_duration_seconds=podcast.get("filter", {}).get("min_duration_seconds", 0),
            reverse=reverse,
            filter_id=episode_id,
            filter_title=episode_title,
        )

    def prepare_episode(
        self,
        podcast_name: str,
        episode_title: str,
        *,
        force: bool = True,
        progress_callback: ProgressCallback | None = None,
    ) -> EpisodeWork:
        if progress_callback:
            progress_callback("resolving", 5, "正在读取 RSS 节目信息…")
        episodes = self.fetch_episodes(
            podcast_name,
            limit=1,
            episode_title=episode_title,
        )
        if not episodes:
            raise PipelineError(f"未找到节目: {podcast_name} - {episode_title}")

        podcast = self.podcast_config(podcast_name)
        episode = episodes[0]
        if not force and self.state_manager.is_processed(episode["id"]):
            raise PipelineError(f"节目已经处理过: {episode['title']}")

        filename_base = build_filename_base(
            podcast_name,
            datetime_to_str(episode["published_parsed"]),
            episode["title"],
        )
        transcript_dir = self.settings.get_podcast_dir(podcast_name, "transcripts")
        work = EpisodeWork(
            podcast=podcast,
            episode=episode,
            filename_base=filename_base,
            raw_path=transcript_dir / f"{filename_base}_raw.txt",
        )

        if work.raw_path.exists():
            if progress_callback:
                progress_callback("downloading", 100, "检测到原始转录缓存，跳过音频下载")
            return work

        if progress_callback:
            progress_callback("downloading", 10, "正在下载源音频…")
        download_dir = self.settings.get_podcast_dir(podcast_name, "downloads")
        audio_path = Downloader(str(download_dir)).download_audio(
            episode["audio_url"],
            filename_base,
        )
        if not audio_path:
            raise PipelineError(f"音频下载失败: {episode['title']}")
        work.audio_path = Path(audio_path)
        if progress_callback:
            progress_callback(
                "downloading",
                100,
                f"源音频已就绪 ({work.audio_path.stat().st_size // 1024}KB)",
            )
        return work

    def transcribe(
        self,
        work: EpisodeWork,
        progress_callback: ProgressCallback | None = None,
    ) -> EpisodeWork:
        audio_file = str(work.audio_path) if work.audio_path else ""
        result: TranscriptionResult | None = self.transcriber.transcribe(
            audio_file,
            cache_path=str(work.raw_path),
            progress_callback=progress_callback,
        )
        if not result or not result.text.strip():
            raise PipelineError(f"转录失败: {work.episode['title']}")
        work.raw_text = result.text
        return work

    def refine(
        self,
        work: EpisodeWork,
        *,
        skip_refine: bool = False,
        progress_callback: ProgressCallback | None = None,
    ) -> EpisodeWork:
        if skip_refine:
            work.transcript_text = work.raw_text
            work.refinement_success = False
            if progress_callback:
                progress_callback("refining", 100, "已跳过 AI 精修")
            return work

        work.transcript_text, work.refinement_success = refine_transcript(
            work.raw_text,
            work.episode.get("summary", "无官方简介"),
            self.settings.REFINER_CONFIG,
            progress_callback,
        )
        return work

    def finalize(self, work: EpisodeWork) -> EpisodeWork:
        transcript_text = work.transcript_text or work.raw_text
        if not transcript_text.strip():
            raise PipelineError("没有可写入的转录文本")

        markdown = self.formatter.format_markdown(
            work.episode,
            transcript_text,
            work.podcast.get("tags", []),
            processing={
                "refinement_success": work.refinement_success,
                "transcript_source": (
                    "ai_refined" if work.refinement_success else "raw_fallback"
                ),
            },
        )
        target_dir = self.settings.get_podcast_dir(work.podcast["name"], "markdown")
        saved_path = self.formatter.save_note(
            markdown,
            work.filename_base,
            target_dir=target_dir,
        )
        if not saved_path or not Path(saved_path).is_file():
            raise PipelineError("Markdown 输出文件没有成功生成")

        work.output_path = Path(saved_path)
        self.state_manager.mark_processed(work.episode["id"])
        return work

    def run_episode(
        self,
        podcast_name: str,
        episode_title: str,
        *,
        force: bool = True,
        skip_refine: bool = False,
        progress_callback: ProgressCallback | None = None,
    ) -> EpisodeWork:
        work = self.prepare_episode(
            podcast_name,
            episode_title,
            force=force,
            progress_callback=progress_callback,
        )
        self.transcribe(work, progress_callback)
        self.refine(
            work,
            skip_refine=skip_refine,
            progress_callback=progress_callback,
        )
        return self.finalize(work)


def enabled_podcast_names(settings_obj=settings) -> Iterable[str]:
    for podcast in settings_obj.PODCASTS:
        if podcast.get("enabled", True):
            yield podcast["name"]
