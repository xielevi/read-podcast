"""音频源获取（Downloader）的单元测试。

只有 ``safe_get`` 直链一条路（逐跳 SSRF 校验）：这里验证后缀推断、体积与安全护栏，
以及失败时带稳定 ``code`` 的 ``SourceError`` 分类（这些 code 会原样上报给 Cloudflare，
由它判定是否重试）。没有任何「解析网页再抓媒体」的兜底。
"""
from __future__ import annotations

import pytest

import core.downloader as downloader
from core.downloader import (
    MIN_AUDIO_BYTES,
    Downloader,
    SourceFetchFailed,
    SourceNotAllowed,
    SourceTooLarge,
)
from core.network_security import UnsafeUrlError, UrlResolutionError

AUDIO_URL = "https://cdn.example.com/ep/475.mp3"


class FakeResponse:
    """requests.Response 的最小替身（safe_get 的返回值）。"""

    def __init__(self, chunks, *, headers=None, url=AUDIO_URL, error=None):
        self._chunks = chunks
        self.headers = headers or {}
        self.url = url
        self._error = error

    def raise_for_status(self):
        if self._error:
            raise self._error

    def iter_content(self, chunk_size=1024):
        yield from self._chunks

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def patch_safe_get(monkeypatch, response):
    """替换 safe_get，并记录调用次数（用于断言零额外网络行为）。"""
    calls = []

    def fake_safe_get(url, **kwargs):
        calls.append(url)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(downloader, "safe_get", fake_safe_get)
    return calls


def write_audio(path, size=MIN_AUDIO_BYTES + 1_000):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x00" * size)
    return path


# ── 后缀推断 ──

@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://cdn.example.com/475.mp3", ".mp3"),
        ("https://cdn.example.com/475.M4A", ".m4a"),
        ("https://cdn.example.com/a%20b.flac", ".flac"),
        ("https://cdn.example.com/475.wav?token=abc", ".wav"),
    ],
)
def test_audio_suffix_from_url_path(url, expected):
    assert Downloader._audio_suffix(url) == expected


@pytest.mark.parametrize(
    ("content_type", "expected"),
    [
        ("audio/mpeg", ".mp3"),
        ("audio/mpeg; charset=binary", ".mp3"),
        ("audio/x-m4a", ".m4a"),
        ("audio/ogg", ".ogg"),
        ("AUDIO/FLAC", ".flac"),
    ],
)
def test_audio_suffix_from_content_type_when_path_has_none(content_type, expected):
    assert Downloader._audio_suffix("https://cdn.example.com/stream", content_type) == expected


def test_audio_suffix_falls_back_to_audio_marker():
    assert Downloader._audio_suffix("https://cdn.example.com/stream") == ".audio"
    assert Downloader._audio_suffix("https://cdn.example.com/stream", "application/json") == ".audio"


def test_audio_suffix_prefers_url_over_content_type():
    assert Downloader._audio_suffix("https://cdn.example.com/475.m4a", "audio/mpeg") == ".m4a"


# ── 下载语义 ──

def test_downloader_creates_download_dir(tmp_path):
    target = tmp_path / "nested" / "downloads"
    assert not target.exists()
    Downloader(target)
    assert target.is_dir()


def test_download_audio_never_reuses_local_files(tmp_path, monkeypatch):
    """复用与否属于 Cloudflare 的 raw checkpoint 语义：服务每次都是一次干净的获取。"""
    dl = Downloader(tmp_path)
    write_audio(tmp_path / "475.mp3", size=MIN_AUDIO_BYTES + 5)
    calls = patch_safe_get(
        monkeypatch, FakeResponse([b"n" * 200_000], headers={"Content-Type": "audio/mpeg"})
    )

    result = dl.download_audio(AUDIO_URL, "475")

    assert calls == [AUDIO_URL]
    assert (tmp_path / "475.mp3").stat().st_size == 200_000
    assert result == str(tmp_path / "475.mp3")


def test_direct_download_writes_final_file_and_leaves_no_part(tmp_path, monkeypatch):
    dl = Downloader(tmp_path)
    payload = [b"a" * 60_000, b"b" * 60_000]
    patch_safe_get(monkeypatch, FakeResponse(payload, headers={"Content-Type": "audio/mpeg"}))

    result = dl._direct_download(AUDIO_URL, "475")

    assert result == str(tmp_path / "475.mp3")
    assert (tmp_path / "475.mp3").stat().st_size == 120_000
    assert list(tmp_path.glob("*.part")) == []


# ── 明确失败（无兜底） ──

def test_non_audio_content_type_fails_clearly(tmp_path, monkeypatch):
    dl = Downloader(tmp_path)
    patch_safe_get(monkeypatch, FakeResponse([b"x" * 200_000], headers={"Content-Type": "text/html"}))

    with pytest.raises(SourceFetchFailed):
        dl.download_audio(AUDIO_URL, "475")
    assert list(tmp_path.iterdir()) == []


def test_unrecognised_audio_format_fails_clearly(tmp_path, monkeypatch):
    dl = Downloader(tmp_path)
    patch_safe_get(monkeypatch, FakeResponse([b"x" * 200_000], headers={"Content-Type": "application/json"}))

    with pytest.raises(SourceFetchFailed):
        dl.download_audio("https://cdn.example.com/stream", "475")
    assert list(tmp_path.iterdir()) == []


def test_undersized_body_fails_clearly(tmp_path, monkeypatch):
    dl = Downloader(tmp_path)
    patch_safe_get(monkeypatch, FakeResponse([b"x" * 1024], headers={"Content-Type": "audio/mpeg"}))

    with pytest.raises(SourceFetchFailed):
        dl.download_audio(AUDIO_URL, "475")
    assert list(tmp_path.iterdir()) == []


def test_transport_error_is_a_retryable_fetch_failure(tmp_path, monkeypatch):
    dl = Downloader(tmp_path)
    patch_safe_get(monkeypatch, RuntimeError("connection reset"))

    with pytest.raises(SourceFetchFailed):
        dl.download_audio(AUDIO_URL, "475")
    assert list(tmp_path.glob("*.part")) == []


def test_http_error_is_a_retryable_fetch_failure(tmp_path, monkeypatch):
    dl = Downloader(tmp_path)
    patch_safe_get(monkeypatch, FakeResponse([], headers={"Content-Type": "audio/mpeg"}, error=RuntimeError("503")))

    with pytest.raises(SourceFetchFailed):
        dl.download_audio(AUDIO_URL, "475")


# ── 体积护栏 ──

def test_direct_download_rejects_declared_oversize(tmp_path, monkeypatch):
    dl = Downloader(tmp_path)
    monkeypatch.setattr(downloader, "MAX_DOWNLOAD_BYTES", 200 * 1024)
    patch_safe_get(
        monkeypatch,
        FakeResponse([b"x" * 10], headers={"Content-Type": "audio/mpeg", "Content-Length": str(999 * 1024)}),
    )

    with pytest.raises(SourceTooLarge):
        dl._direct_download(AUDIO_URL, "475")
    assert list(tmp_path.iterdir()) == []


def test_direct_download_rejects_streamed_oversize(tmp_path, monkeypatch):
    dl = Downloader(tmp_path)
    monkeypatch.setattr(downloader, "MAX_DOWNLOAD_BYTES", 200 * 1024)
    chunks = [b"x" * 150_000] * 3  # 累计超过上限
    patch_safe_get(monkeypatch, FakeResponse(chunks, headers={"Content-Type": "audio/mpeg"}))

    with pytest.raises(SourceTooLarge):
        dl._direct_download(AUDIO_URL, "475")
    assert list(tmp_path.glob("*.part")) == []  # 半成品必须清理


def test_per_call_max_bytes_tightens_the_service_limit(tmp_path, monkeypatch):
    """Cloudflare 给定的 source.max_bytes（自定义上传 200 MiB 硬上限）与服务上限取较小者。"""
    dl = Downloader(tmp_path)
    patch_safe_get(
        monkeypatch,
        FakeResponse([b"x" * 150_000] * 2, headers={"Content-Type": "audio/mpeg"}),
    )

    with pytest.raises(SourceTooLarge):
        dl.download_audio(AUDIO_URL, "475", max_bytes=250_000)
    assert list(tmp_path.iterdir()) == []


def test_per_call_max_bytes_boundary_is_inclusive(tmp_path, monkeypatch):
    dl = Downloader(tmp_path)
    patch_safe_get(monkeypatch, FakeResponse([b"x" * 200_000], headers={"Content-Type": "audio/mpeg"}))

    assert dl.download_audio(AUDIO_URL, "475", max_bytes=200_000) == str(tmp_path / "475.mp3")


def test_per_call_max_bytes_cannot_loosen_the_service_limit(tmp_path, monkeypatch):
    dl = Downloader(tmp_path)
    monkeypatch.setattr(downloader, "MAX_DOWNLOAD_BYTES", 200 * 1024)
    patch_safe_get(
        monkeypatch,
        FakeResponse([b"x" * 10], headers={"Content-Type": "audio/mpeg", "Content-Length": str(999 * 1024)}),
    )

    with pytest.raises(SourceTooLarge):
        dl.download_audio(AUDIO_URL, "475", max_bytes=10**12)


# ── SSRF 边界 ──

def test_direct_download_private_address_is_not_allowed(tmp_path, monkeypatch):
    dl = Downloader(tmp_path)
    patch_safe_get(monkeypatch, UnsafeUrlError("URL points to a private or local network"))

    with pytest.raises(SourceNotAllowed):
        dl.download_audio("http://10.0.0.5/a.mp3", "475")


def test_direct_download_unresolvable_host_is_a_retryable_fetch_failure(tmp_path, monkeypatch):
    dl = Downloader(tmp_path)
    patch_safe_get(monkeypatch, UrlResolutionError("URL host could not be resolved"))

    with pytest.raises(SourceFetchFailed):
        dl.download_audio(AUDIO_URL, "475")


def test_error_codes_are_stable():
    assert SourceNotAllowed.code == "source_not_allowed"
    assert SourceTooLarge.code == "source_too_large"
    assert SourceFetchFailed.code == "source_fetch_failed"


def test_downloader_has_no_fallback_route():
    """安全不变式：Downloader 没有任何绕过逐跳校验的第二条路（例如 yt-dlp）。"""
    source = downloader.Path(downloader.__file__).read_text(encoding="utf-8")
    for forbidden in ("subprocess", "_yt_dlp_download", "allow_ytdlp_fallback", "import yt_dlp"):
        assert forbidden not in source
