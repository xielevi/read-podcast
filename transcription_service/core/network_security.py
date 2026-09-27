"""出站 HTTP 安全助手。

用户提供的媒体 URL 在下载前逐跳校验解析地址是否为公网，防 SSRF。
"""
from __future__ import annotations

import ipaddress
import os
import socket
from urllib.parse import urljoin, urlsplit, urlunsplit

import requests

OUTBOUND_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


class UnsafeUrlError(ValueError):
    """URL 可达非公网地址（或 scheme / 凭据不合规）时抛出。"""


class UrlResolutionError(UnsafeUrlError):
    """主机名暂时无法解析。与「指向私网」不同：这是可能自行恢复的环境问题。"""


def redact_url(url: str) -> str:
    """返回不含凭据/查询/片段的日志安全 URL。"""
    try:
        parts = urlsplit(str(url or ""))
        hostname = parts.hostname or ""
        if ":" in hostname and not hostname.startswith("["):
            hostname = f"[{hostname}]"
        port = f":{parts.port}" if parts.port else ""
        return urlunsplit((parts.scheme, f"{hostname}{port}", "", "", ""))
    except ValueError:
        return "<invalid-url>"


FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")


NAT64_WELL_KNOWN = ipaddress.ip_network("64:ff9b::/96")
SIX_TO_FOUR = ipaddress.ip_network("2002::/16")


def _embedded_ipv4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """IPv6 地址里内嵌的 IPv4（IPv4-mapped / NAT64 / 6to4）。

    这些形式会被网关或内核翻译成对该 IPv4 的访问，所以必须按内嵌的 IPv4 判定，
    否则 ``::ffff:127.0.0.1`` / ``64:ff9b::7f00:1`` 之类可绕过私网检查。
    """
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip in NAT64_WELL_KNOWN:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    if ip in SIX_TO_FOUR:
        return ipaddress.IPv4Address((int(ip) >> 80) & 0xFFFFFFFF)
    return None


def _is_allowed_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(ip)
        if embedded is not None:
            return _is_allowed_address(str(embedded))
    if ip.is_global:
        return True
    return isinstance(ip, ipaddress.IPv4Address) and ip in FAKE_IP_NETWORK


def _allowed_audio_source_hosts() -> set[str]:
    raw = (
        os.environ.get("ALLOWED_AUDIO_SOURCE_HOSTS")
        or os.environ.get("READ_PODCAST_ALLOWED_AUDIO_SOURCE_HOSTS")
        or ""
    )
    return {h.strip().lower() for h in raw.split(",") if h.strip()}


def validate_public_url(url: str) -> str:
    """只允许解析到全局可路由地址（或 Fake-IP 地址池、或显式受信来源主机白名单）的 http(s) URL。"""
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
        raise UrlResolutionError("URL host could not be resolved") from exc
    if not addresses:
        raise UrlResolutionError("URL host did not resolve")
    allowed_hosts = _allowed_audio_source_hosts()
    if parts.hostname.lower() in allowed_hosts:
        return candidate
    if any(not _is_allowed_address(address) for address in addresses):
        raise UnsafeUrlError("URL points to a private or local network")
    return candidate


def safe_get(url: str, *, max_redirects: int = 5, **kwargs) -> requests.Response:
    """逐跳校验重定向目标后再发起 GET。"""
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
