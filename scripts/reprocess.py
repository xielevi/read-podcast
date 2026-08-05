"""对已有转录执行单集或批量重精修。"""
from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path


PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from modules.config import settings
from modules.formatter import Formatter
from modules.pipeline import refine_transcript
from modules.rss_parser import RSSParser
from modules.utils import extract_frontmatter, extract_metadata_from_text, setup_logging


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="重新精修已有转录")
    subparsers = parser.add_subparsers(dest="command", required=True)

    single = subparsers.add_parser("single", help="重新精修一份原始转录")
    single.add_argument("path", nargs="?", help="*_raw.txt 文件路径")
    single.add_argument("--podcast", help="播客名称")
    single.add_argument("--title", help="节目标题关键词")
    single.add_argument("--summary", help="节目背景简介")

    batch = subparsers.add_parser("batch", help="批量重处理历史转录")
    batch.add_argument("--podcast", help="播客名称；默认使用第一个启用项")
    return parser.parse_args()


def _find_raw_transcript(path: str | None, podcast: str | None, title: str | None) -> Path:
    if path:
        candidate = Path(path).expanduser().resolve()
        if candidate.is_file():
            return candidate
    if podcast and title:
        transcript_dir = settings.PROJECT_ROOT / "workspace" / podcast / "transcripts"
        matches = sorted(transcript_dir.glob(f"*{title}*_raw.txt"))
        if matches:
            return matches[0]
    raise FileNotFoundError("请提供有效路径，或同时提供 --podcast 与 --title")


def _single(args: argparse.Namespace, logger) -> bool:
    raw_path = _find_raw_transcript(args.path, args.podcast, args.title)
    raw_text = raw_path.read_text(encoding="utf-8")
    podcast_name = args.podcast or "Unknown"
    if podcast_name == "Unknown" and "workspace" in raw_path.parts:
        workspace_index = raw_path.parts.index("workspace")
        if len(raw_path.parts) > workspace_index + 1:
            podcast_name = raw_path.parts[workspace_index + 1]

    output_name = raw_path.name.replace("_raw.txt", ".md")
    if output_name == raw_path.name:
        output_name = f"{raw_path.stem}.md"
    target_dir = settings.get_podcast_dir(podcast_name, "markdown")
    output_path = target_dir / output_name

    frontmatter = ""
    summary = args.summary or ""
    if output_path.exists():
        metadata, frontmatter = extract_frontmatter(output_path.read_text(encoding="utf-8"))
        if metadata:
            summary = summary or metadata.get("summary", "") or metadata.get("description", "")

    started = time.monotonic()
    transcript, refined = refine_transcript(raw_text, summary, settings.REFINER_CONFIG)
    content = f"{frontmatter}\n{transcript}" if frontmatter else transcript
    status = "AI refined" if refined else "raw fallback"
    content += f"\n\n---\n*{status} | Duration: {time.monotonic() - started:.2f}s*"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(content, encoding="utf-8")
    logger.info("已保存: %s (%s)", output_path, status)
    return True


def _podcast_config(name: str | None) -> dict:
    if name:
        podcast = settings.get_podcast_config(name)
        if podcast:
            return podcast
        raise ValueError(f"找不到播客配置: {name}")
    for podcast in settings.PODCASTS:
        if podcast.get("enabled", True):
            return podcast
    raise ValueError("配置中没有启用的播客")


def _match_rss_episode(filename: str, episodes: list[dict]) -> dict | None:
    number_match = re.search(r"_\d{3,4}_", filename)
    episode_number = number_match.group(0).strip("_") if number_match else None
    for episode in episodes:
        if episode["title"] in filename or (episode_number and episode_number in episode["title"]):
            return episode
    return None


def _raw_for_markdown(source_dir: Path, filename_base: str) -> Path | None:
    parts = filename_base.split("_")
    prefix = "_".join(parts[:3]) if len(parts) >= 3 else parts[0]
    matches = sorted(source_dir.glob(f"{prefix}*_raw.txt"))
    if matches:
        return matches[0]
    fuzzy = re.search(r"_\d{4,8}_\d+", filename_base)
    matches = sorted(source_dir.glob(f"*{fuzzy.group(0)}*_raw.txt")) if fuzzy else []
    return matches[0] if matches else None


def _batch(args: argparse.Namespace, logger) -> bool:
    podcast = _podcast_config(args.podcast)
    source_dir = settings.PROJECT_ROOT / "workspace" / "transfer_txt"
    episodes = RSSParser(podcast["rss_url"], podcast["name"]).fetch_episodes(limit=40)
    formatter = Formatter()
    failed = False

    for md_path in sorted(source_dir.glob("*.md")):
        content = md_path.read_text(encoding="utf-8")
        if "Reprocessed with AI" in content:
            continue
        metadata, _ = extract_frontmatter(content)
        if not metadata:
            episode = _match_rss_episode(md_path.stem, episodes)
            if not episode:
                logger.warning("无法匹配 RSS，跳过: %s", md_path.name)
                failed = True
                continue
            metadata = {
                "title": episode["title"],
                "podcast": episode["podcast_name"],
                "date": episode["published"],
                "duration": episode["duration"],
                "link": episode["audio_url"],
                "source_link": episode["link"],
                "summary": episode["summary"],
                "tags": podcast.get("tags", []),
            }

        raw_path = _raw_for_markdown(source_dir, md_path.stem)
        if not raw_path:
            logger.warning("未找到原始转录，跳过: %s", md_path.name)
            failed = True
            continue
        raw_text = raw_path.read_text(encoding="utf-8")
        summary = metadata.get("description", "") or metadata.get("summary", "") or "无官方简介"
        identity = extract_metadata_from_text(metadata.get("title", md_path.stem), summary)
        logger.info(
            "重新精修: %s (hosts=%s, guests=%s)",
            md_path.name,
            "、".join(identity["hosts"]),
            "、".join(identity["guests"]),
        )
        transcript, refined = refine_transcript(raw_text, summary, settings.REFINER_CONFIG)
        episode_data = {
            "title": metadata.get("title"),
            "podcast_name": metadata.get("podcast", podcast["name"]),
            "published": metadata.get("date"),
            "duration": metadata.get("duration"),
            "audio_url": metadata.get("link"),
            "link": metadata.get("source_link"),
            "summary": summary,
            "id": metadata.get("id", "legacy"),
        }
        markdown = formatter.format_markdown(
            episode_data,
            transcript,
            metadata.get("tags", []),
            processing={
                "refinement_success": refined,
                "transcript_source": "ai_refined" if refined else "raw_fallback",
            },
        )
        target_dir = settings.get_podcast_dir(episode_data["podcast_name"], "markdown")
        formatter.save_note(markdown, md_path.stem, target_dir=target_dir)
    return not failed


def main() -> None:
    args = _arguments()
    logger = setup_logging(settings.LOG_DIR, name="Reprocess")
    try:
        succeeded = _single(args, logger) if args.command == "single" else _batch(args, logger)
    except (FileNotFoundError, ValueError) as exc:
        logger.error("%s", exc)
        raise SystemExit(1) from exc
    if not succeeded:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
