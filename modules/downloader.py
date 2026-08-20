from __future__ import annotations

import logging
import mimetypes
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlparse

from modules.config import settings
from modules.network_security import redact_url, safe_get, validate_public_url


logger = logging.getLogger(__name__)

AUDIO_EXTENSIONS = {
    ".aac",
    ".flac",
    ".m4a",
    ".mp3",
    ".mp4",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
    ".wma",
}
MIN_AUDIO_BYTES = 100 * 1024
MAX_DOWNLOAD_BYTES = max(
    MIN_AUDIO_BYTES + 1,
    int(settings.RUNTIME_CONFIG.get("max_download_bytes", 2 * 1024 * 1024 * 1024)),
)
DOWNLOAD_TIMEOUT_SECONDS = max(
    60,
    int(settings.RUNTIME_CONFIG.get("download_timeout_seconds", 1800)),
)
CONTENT_TYPE_EXTENSIONS = {
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "audio/x-m4a": ".m4a",
}


class Downloader:
    def __init__(self, download_dir):
        self.download_dir = Path(download_dir).expanduser()
        self.download_dir.mkdir(parents=True, exist_ok=True)

    def _existing_audio(self, filename_base: str) -> Path | None:
        candidates = sorted(
            (
                path
                for path in self.download_dir.glob(f"{filename_base}.*")
                if path.is_file()
                and path.suffix.lower() in AUDIO_EXTENSIONS
                and path.stat().st_size > MIN_AUDIO_BYTES
            ),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        return candidates[0] if candidates else None

    @staticmethod
    def _audio_suffix(url: str, content_type: str = "") -> str:
        url_suffix = Path(unquote(urlparse(url).path)).suffix.lower()
        if url_suffix in AUDIO_EXTENSIONS:
            return url_suffix

        media_type = content_type.split(";", 1)[0].strip().lower()
        if media_type in CONTENT_TYPE_EXTENSIONS:
            return CONTENT_TYPE_EXTENSIONS[media_type]
        guessed = mimetypes.guess_extension(media_type) if media_type else None
        return guessed if guessed in AUDIO_EXTENSIONS else ".audio"

    def _direct_download(self, url: str, filename_base: str) -> str | None:
        """优先直接保存 RSS enclosure 的源音频，不做转码。"""
        logger.info("正在直接下载源音频: %s", redact_url(url))
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
        }
        temp_path: Path | None = None
        try:
            with safe_get(
                url,
                headers=headers,
                stream=True,
                timeout=(15, 120),
            ) as response:
                response.raise_for_status()
                declared = response.headers.get("Content-Length")
                if declared and int(declared) > MAX_DOWNLOAD_BYTES:
                    raise ValueError("音频超过配置的下载大小上限")
                content_type = response.headers.get("Content-Type", "")
                if content_type and not (
                    content_type.lower().startswith("audio/")
                    or content_type.lower().startswith("application/octet-stream")
                ):
                    logger.warning("直链返回非音频类型 %s，改用 yt-dlp", content_type)
                    return None

                suffix = self._audio_suffix(response.url or url, content_type)
                if suffix == ".audio":
                    logger.warning("无法识别直链音频格式，改用 yt-dlp")
                    return None

                final_path = self.download_dir / f"{filename_base}{suffix}"
                temp_path = final_path.with_suffix(f"{final_path.suffix}.part")
                total_bytes = 0
                with temp_path.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            total_bytes += len(chunk)
                            if total_bytes > MAX_DOWNLOAD_BYTES:
                                raise ValueError("音频超过配置的下载大小上限")
                            handle.write(chunk)

            if not temp_path.exists() or temp_path.stat().st_size <= MIN_AUDIO_BYTES:
                logger.warning("直链下载产物过小，改用 yt-dlp")
                return None

            temp_path.replace(final_path)
            logger.info(
                "源音频下载成功: %s (%dKB)",
                final_path,
                final_path.stat().st_size // 1024,
            )
            return str(final_path)
        except Exception:
            logger.warning("直链下载失败，改用 yt-dlp（URL 与异常详情未写入日志）")
            return None
        finally:
            if temp_path and temp_path.exists():
                temp_path.unlink(missing_ok=True)

    def _yt_dlp_download(self, url: str, filename_base: str) -> str | None:
        """让 yt-dlp 处理特殊媒体链接，但保留下载到的源格式。"""
        try:
            validate_public_url(url)
        except ValueError as exc:
            logger.error("拒绝不安全的媒体 URL: %s", exc)
            return None
        output_template = str(self.download_dir / f"{filename_base}.%(ext)s")
        command = [
            "yt-dlp",
            "--format",
            "bestaudio/best",
            "--output",
            output_template,
            "--no-playlist",
            "--max-filesize",
            str(MAX_DOWNLOAD_BYTES),
            "--socket-timeout",
            "120",
            "--quiet",
            "--print",
            "after_move:filepath",
            url,
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=True,
                timeout=DOWNLOAD_TIMEOUT_SECONDS,
            )
        except subprocess.CalledProcessError:
            logger.error("yt-dlp 下载失败（命令输出未写入日志）")
            return None
        except subprocess.TimeoutExpired:
            logger.error("yt-dlp 下载超时（%ds）", DOWNLOAD_TIMEOUT_SECONDS)
            return None

        printed_paths = [Path(line.strip()) for line in result.stdout.splitlines() if line.strip()]
        for path in reversed(printed_paths):
            if path.exists() and path.stat().st_size > MIN_AUDIO_BYTES:
                logger.info("yt-dlp 源音频下载成功: %s", path)
                return str(path)

        existing = self._existing_audio(filename_base)
        if existing:
            logger.info("yt-dlp 源音频下载成功: %s", existing)
            return str(existing)
        logger.error("yt-dlp 执行完成但没有生成可用音频")
        return None

    def download_audio(self, url: str, filename_base: str) -> str | None:
        existing = self._existing_audio(filename_base)
        if existing:
            logger.info("音频文件已存在，跳过下载: %s", existing)
            return str(existing)

        return self._direct_download(url, filename_base) or self._yt_dlp_download(
            url,
            filename_base,
        )
