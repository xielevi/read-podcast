"""音频源获取（fetch audio source）。

**安全边界：**

- 唯一路径是 ``safe_get()`` 直链抓取。``safe_get`` 在**每一跳重定向之前**都重新调用
  ``validate_public_url()``，所以每一次真实出站连接的目标地址都经过校验（拒绝私网 /
  本机 / 链路本地 / 非 http(s) / 带凭据的 URL）。
- 没有任何「解析网页再抓媒体」的兜底（例如 yt-dlp）：那类工具自行跟随重定向并请求新的
  媒体 URL，会绕过逐跳校验。源 URL 由 Cloudflare 下发且已经在 Edge 侧做过 SSRF 校验；
  直链拿不到音频就明确失败，由 Cloudflare 决定重试与否。

每次调用都是一次干净的获取：不复用本地缓存（复用与否属于 Cloudflare 的 raw checkpoint 语义），
失败以带稳定 ``code`` 的 ``SourceError`` 抛出，由上层如实上报。体积上限 =
min(服务内建默认, 调用方给定的 ``max_bytes``)。
"""
from __future__ import annotations

import logging
import mimetypes
from pathlib import Path
from urllib.parse import unquote, urlparse

from core.config import DOWNLOAD_CONNECT_TIMEOUT_SECONDS, DOWNLOAD_READ_TIMEOUT_SECONDS, MAX_DOWNLOAD_BYTES as SERVICE_MAX_DOWNLOAD_BYTES
from core.network_security import (
    OUTBOUND_USER_AGENT,
    UnsafeUrlError,
    UrlResolutionError,
    redact_url,
    safe_get,
)

logger = logging.getLogger(__name__)

AUDIO_EXTENSIONS = {".aac", ".flac", ".m4a", ".mp3", ".mp4", ".ogg", ".opus", ".wav", ".webm", ".wma"}
MIN_AUDIO_BYTES = 100 * 1024
MAX_DOWNLOAD_BYTES = max(MIN_AUDIO_BYTES + 1, SERVICE_MAX_DOWNLOAD_BYTES)
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


class SourceError(Exception):
    """音频源无法取得。``code`` 是稳定的机器可读原因，由服务原样上报给 Cloudflare。"""

    code = "source_fetch_failed"

    def __init__(self, message: str = ""):
        super().__init__(message or self.code)


class SourceNotAllowed(SourceError):
    """URL 不合规（非 http(s) / 含凭据 / 指向私网或本机）——重试不会改变结论。"""

    code = "source_not_allowed"


class SourceTooLarge(SourceError):
    """音频超过体积上限（服务内建默认或请求给定的 ``max_bytes``）——重试不会改变结论。"""

    code = "source_too_large"


class SourceFetchFailed(SourceError):
    """网络 / 对端 / 解析等暂时性原因导致取不到音频。"""

    code = "source_fetch_failed"


class Downloader:
    def __init__(self, download_dir):
        self.download_dir = Path(download_dir).expanduser()
        self.download_dir.mkdir(parents=True, exist_ok=True)

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

    def _direct_download(self, url: str, filename_base: str, max_bytes: int | None = None) -> str:
        """直链下载。失败抛 ``SourceError``，成功返回本地路径。"""
        max_bytes = max_bytes or MAX_DOWNLOAD_BYTES
        logger.info("正在直接下载源音频: %s", redact_url(url))
        headers = {"User-Agent": OUTBOUND_USER_AGENT}
        temp_path: Path | None = None
        try:
            with safe_get(url, headers=headers, stream=True, timeout=(DOWNLOAD_CONNECT_TIMEOUT_SECONDS, DOWNLOAD_READ_TIMEOUT_SECONDS)) as response:
                response.raise_for_status()
                declared = response.headers.get("Content-Length")
                if declared and int(declared) > max_bytes:
                    raise SourceTooLarge(f"音频声明体积 {declared} 超过上限 {max_bytes}")
                content_type = response.headers.get("Content-Type", "")
                if content_type and not (
                    content_type.lower().startswith("audio/")
                    or content_type.lower().startswith("application/octet-stream")
                ):
                    raise SourceFetchFailed(f"直链返回非音频内容类型 {content_type}")
                suffix = self._audio_suffix(response.url or url, content_type)
                if suffix == ".audio":
                    raise SourceFetchFailed("无法识别直链音频格式")
                final_path = self.download_dir / f"{filename_base}{suffix}"
                temp_path = final_path.with_suffix(f"{final_path.suffix}.part")
                total_bytes = 0
                with temp_path.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            total_bytes += len(chunk)
                            if total_bytes > max_bytes:
                                raise SourceTooLarge(f"音频实际体积超过上限 {max_bytes}")
                            handle.write(chunk)
            if not temp_path.exists() or temp_path.stat().st_size <= MIN_AUDIO_BYTES:
                raise SourceFetchFailed("直链下载产物过小，不是可用的音频")
            temp_path.replace(final_path)
            logger.info("源音频下载成功: %s (%dKB)", final_path, final_path.stat().st_size // 1024)
            return str(final_path)
        except SourceError:
            raise
        except UrlResolutionError as exc:
            raise SourceFetchFailed("音频主机名暂时无法解析") from exc
        except UnsafeUrlError as exc:
            raise SourceNotAllowed(str(exc)) from exc
        except Exception as exc:
            logger.warning("直链下载失败: %s（URL 与异常详情未写入日志）", type(exc).__name__)
            raise SourceFetchFailed("无法直链取得音频") from exc
        finally:
            if temp_path and temp_path.exists():
                temp_path.unlink(missing_ok=True)

    def download_audio(self, url: str, filename_base: str, max_bytes: int | None = None) -> str:
        """取回音频到 ``download_dir``，返回本地路径；失败抛 ``SourceError``。

        只有 ``safe_get`` 直链这一条路——因此「每一次出站连接的目标都经过逐跳校验」这句声明成立。
        """
        limit = MAX_DOWNLOAD_BYTES if not max_bytes else max(1, min(MAX_DOWNLOAD_BYTES, int(max_bytes)))
        return self._direct_download(url, filename_base, limit)
