"""Outbound HTTP safety helpers for user-supplied RSS and media URLs."""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urljoin, urlsplit, urlunsplit

import requests


class UnsafeUrlError(ValueError):
    """Raised when a URL can reach a non-public network address."""


def redact_url(url: str) -> str:
    """Return a log-safe URL without credentials, query parameters, or fragments."""
    try:
        parts = urlsplit(str(url or ""))
        hostname = parts.hostname or ""
        if ":" in hostname and not hostname.startswith("["):
            hostname = f"[{hostname}]"
        port = f":{parts.port}" if parts.port else ""
        return urlunsplit((parts.scheme, f"{hostname}{port}", "", "", ""))
    except ValueError:
        return "<invalid-url>"


def validate_public_url(url: str) -> str:
    """Allow only HTTP(S) URLs whose resolved addresses are globally routable."""
    candidate = str(url or "").strip()
    parts = urlsplit(candidate)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise UnsafeUrlError("URL must use http or https")
    if parts.username or parts.password:
        raise UnsafeUrlError("URL credentials are not allowed")

    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(parts.hostname, parts.port or 443, type=socket.SOCK_STREAM)
        }
    except socket.gaierror as exc:
        raise UnsafeUrlError("URL host could not be resolved") from exc
    if not addresses:
        raise UnsafeUrlError("URL host did not resolve")
    if any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise UnsafeUrlError("URL points to a private or local network")
    return candidate


def safe_get(url: str, *, max_redirects: int = 5, **kwargs) -> requests.Response:
    """GET a URL while validating every redirect target before requesting it."""
    current = str(url or "").strip()
    kwargs.pop("allow_redirects", None)
    for _ in range(max_redirects + 1):
        validate_public_url(current)
        response = requests.get(current, allow_redirects=False, **kwargs)
        if response.is_redirect or response.is_permanent_redirect:
            location = response.headers.get("Location")
            response.close()
            if not location:
                raise requests.TooManyRedirects("redirect response had no Location header")
            current = urljoin(current, location)
            continue
        return response
    raise requests.TooManyRedirects(f"too many redirects (>{max_redirects})")


def read_limited(response: requests.Response, max_bytes: int) -> bytes:
    """Read a streamed response without allowing it to exceed ``max_bytes``."""
    declared = response.headers.get("Content-Length")
    if declared:
        try:
            declared_size = int(declared)
        except ValueError:
            declared_size = 0
        if declared_size > max_bytes:
            raise ValueError("remote content exceeds the configured size limit")

    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_content(chunk_size=1024 * 1024):
        if not chunk:
            continue
        total += len(chunk)
        if total > max_bytes:
            raise ValueError("remote content exceeds the configured size limit")
        chunks.append(chunk)
    return b"".join(chunks)
