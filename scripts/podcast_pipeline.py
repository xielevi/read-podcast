"""Podcast2MD 流水线的维护入口；正式交互入口为 WebUI。"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from modules.config import Settings, settings
from modules.pipeline import PipelineError, PodcastPipeline, enabled_podcast_names
from modules.utils import acquire_lock, check_environment, setup_logging


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Podcast2MD 后台维护流水线")
    parser.add_argument("--config", help="配置文件路径")
    parser.add_argument("--limit", type=int, default=1, help="每个播客处理的节目数量")
    parser.add_argument("--reverse", action="store_true", help="从最早节目开始")
    parser.add_argument("--id", help="指定 RSS 节目 ID")
    parser.add_argument("--podcast", help="仅处理指定播客")
    parser.add_argument("--title", help="节目标题关键词")
    parser.add_argument("--dry-run", action="store_true", help="仅列出节目")
    parser.add_argument("--force", action="store_true", help="允许重跑已处理节目")
    parser.add_argument("--skip-refine", action="store_true", help="跳过 AI 精修")
    return parser.parse_args()


def main() -> None:
    if not check_environment():
        raise SystemExit(1)

    args = _arguments()
    loaded_settings = Settings(args.config) if args.config else settings

    logger = setup_logging(loaded_settings.LOG_DIR)
    _lock = acquire_lock("podcast_worker")
    pipeline = PodcastPipeline(loaded_settings)
    failed = False

    def progress(stage: str, pct: int, message: str) -> None:
        logger.info("  [%s] %d%% | %s", stage.upper(), max(pct, 0), message)

    podcast_names = (
        [args.podcast]
        if args.podcast
        else list(enabled_podcast_names(loaded_settings))
    )
    logger.info("=== 开始 Podcast2MD 维护流水线 ===")
    for podcast_name in podcast_names:
        try:
            episodes = pipeline.fetch_episodes(
                podcast_name,
                limit=args.limit,
                reverse=args.reverse,
                episode_id=args.id,
                episode_title=args.title,
            )
        except PipelineError as exc:
            logger.error("%s", exc)
            failed = True
            continue

        for episode in episodes:
            if args.dry_run:
                logger.info("[DRY-RUN] %s - %s", podcast_name, episode["title"])
                continue
            try:
                work = pipeline.run_episode(
                    podcast_name,
                    episode["title"],
                    force=args.force,
                    skip_refine=args.skip_refine,
                    progress_callback=progress,
                )
                logger.info("成功生成: %s", work.output_path)
            except Exception as exc:
                logger.exception("处理失败 [%s - %s]: %s", podcast_name, episode["title"], exc)
                failed = True

    logger.info("=== Podcast2MD 维护流水线结束 ===")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
