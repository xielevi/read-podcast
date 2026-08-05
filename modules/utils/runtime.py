import logging
import os
import subprocess
import sys
import time
from datetime import datetime

if sys.platform == "darwin":
    extra_paths = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
    current_paths = os.environ.get("PATH", "").split(os.pathsep)
    for path in extra_paths:
        if path not in current_paths:
            current_paths.insert(0, path)
    os.environ["PATH"] = os.pathsep.join(current_paths)


def setup_logging(log_dir, name="ReadPodcast"):
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{datetime.now():%Y-%m-%d}.log"
    root_logger = logging.getLogger()
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)
    from modules.config import settings

    root_logger.setLevel(logging.DEBUG if settings.RUNTIME_CONFIG.get("debug", False) else logging.INFO)
    formatter = logging.Formatter("[%(levelname)-8s] %(asctime)s [%(name)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    stream_handler = logging.StreamHandler(sys.stdout)
    file_handler.setFormatter(formatter)
    stream_handler.setFormatter(formatter)
    root_logger.addHandler(file_handler)
    root_logger.addHandler(stream_handler)
    for logger_name in ("httpx", "httpcore", "feedparser"):
        logging.getLogger(logger_name).setLevel(logging.WARNING)
    return logging.getLogger(name)


def datetime_to_str(struct_time):
    return "UnknownDate" if not struct_time else time.strftime("%Y%m%d", struct_time)


def check_environment():
    dependencies = {"yt-dlp": ["yt-dlp", "--version"], "ffmpeg": ["ffmpeg", "-version"]}
    missing = []
    for name, command in dependencies.items():
        try:
            subprocess.run(command, capture_output=True, check=True, timeout=10)
        except (subprocess.SubprocessError, FileNotFoundError):
            missing.append(name)
    if missing:
        logging.error("缺失必要的外部依赖工具: %s", ", ".join(missing))
        print(f"未安装: {', '.join(missing)}（macOS: brew install，Linux: 系统包管理器）")
        return False
    return True
