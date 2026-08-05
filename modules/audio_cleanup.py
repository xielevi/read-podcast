import logging
import time
from pathlib import Path


logger = logging.getLogger(__name__)

AUDIO_EXTENSIONS = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac", ".opus", ".wma"}


def _dedupe_paths(paths):
    unique_paths = []
    seen = set()
    for path in paths:
        resolved = Path(path).expanduser().resolve()
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        unique_paths.append(resolved)
    return unique_paths


def get_audio_cleanup_roots(project_root: Path, upload_dir: Path, download_dir: Path):
    workspace_dir = project_root / "workspace"
    candidate_paths = [upload_dir, download_dir]

    if workspace_dir.exists():
        candidate_paths.extend(path for path in workspace_dir.glob("*/downloads") if path.is_dir())

    return [path for path in _dedupe_paths(candidate_paths) if path.exists() and path.is_dir()]


def cleanup_expired_audio(project_root: Path, upload_dir: Path, download_dir: Path, retention_days: int = 7):
    cutoff_ts = time.time() - (retention_days * 24 * 60 * 60)
    summary = {
        "retention_days": retention_days,
        "checked_dirs": [],
        "deleted_files": [],
        "deleted_count": 0,
        "freed_bytes": 0,
        "errors": [],
    }

    for root_dir in get_audio_cleanup_roots(project_root, upload_dir, download_dir):
        summary["checked_dirs"].append(str(root_dir))
        for file_path in root_dir.rglob("*"):
            if not file_path.is_file() or file_path.suffix.lower() not in AUDIO_EXTENSIONS:
                continue

            try:
                file_stat = file_path.stat()
            except FileNotFoundError:
                continue
            except Exception as exc:
                message = f"读取文件状态失败: {file_path} ({exc})"
                logger.warning(message)
                summary["errors"].append(message)
                continue

            if file_stat.st_mtime > cutoff_ts:
                continue

            try:
                file_path.unlink()
            except Exception as exc:
                message = f"删除过期音频失败: {file_path} ({exc})"
                logger.warning(message)
                summary["errors"].append(message)
                continue

            summary["deleted_files"].append(str(file_path))
            summary["deleted_count"] += 1
            summary["freed_bytes"] += file_stat.st_size

    return summary