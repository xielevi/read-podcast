import socket

import pytest

from modules import network_security
from modules.network_security import UnsafeUrlError, redact_url, safe_get, validate_public_url


def test_redact_url_removes_credentials_query_and_fragment():
    assert redact_url("https://user:secret@example.com/feed.xml?token=abc#part") == "https://example.com"


def test_validate_public_url_blocks_private_address(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))],
    )
    with pytest.raises(UnsafeUrlError, match="private or local"):
        validate_public_url("http://example.test/feed")


def test_validate_public_url_accepts_public_address(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))],
    )
    assert validate_public_url("https://example.test/feed") == "https://example.test/feed"


def test_safe_get_rejects_private_redirect_before_following(monkeypatch):
    class RedirectResponse:
        is_redirect = True
        is_permanent_redirect = False
        headers = {"Location": "http://127.0.0.1/internal"}

        def close(self):
            return None

    calls = []
    monkeypatch.setattr(
        network_security,
        "validate_public_url",
        lambda url: (_ for _ in ()).throw(UnsafeUrlError("private"))
        if "127.0.0.1" in url
        else url,
    )
    monkeypatch.setattr(
        network_security.requests,
        "get",
        lambda url, **_kwargs: calls.append(url) or RedirectResponse(),
    )

    with pytest.raises(UnsafeUrlError, match="private"):
        safe_get("https://public.example/feed")

    assert calls == ["https://public.example/feed"]
