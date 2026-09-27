"""出站安全（SSRF）测试：音频 URL 只允许解析到全局可路由地址，重定向逐跳复核。"""
from __future__ import annotations

import socket

import pytest
import requests

import core.network_security as ns
from core.network_security import UnsafeUrlError, UrlResolutionError, redact_url, safe_get, validate_public_url


def resolve_to(monkeypatch, *addresses):
    def fake_getaddrinfo(host, port, type=0, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port)) for address in addresses]

    monkeypatch.setattr(ns.socket, "getaddrinfo", fake_getaddrinfo)


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/a.mp3",
        "gopher://example.com/",
        "https://user:pass@example.com/a.mp3",
        "http:///a.mp3",
        "",
    ],
)
def test_rejects_non_http_credentials_and_hostless_urls(url):
    with pytest.raises(UnsafeUrlError):
        validate_public_url(url)


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",          # localhost
        "127.1.2.3",
        "10.0.0.5",           # RFC1918
        "172.16.9.9",
        "192.168.1.10",
        "169.254.169.254",    # 云元数据 / link-local
        "0.0.0.0",
        "100.64.0.1",         # CGNAT
        "::1",                # IPv6 loopback
        "fe80::1",            # IPv6 link-local
        "fc00::1",            # IPv6 ULA
        "::ffff:127.0.0.1",   # IPv4-mapped IPv6（回环）
        "::ffff:10.0.0.5",    # IPv4-mapped IPv6（私网）
        "::ffff:169.254.169.254",
        "64:ff9b::7f00:1",    # NAT64 → 127.0.0.1
        "64:ff9b::a00:5",     # NAT64 → 10.0.0.5
        "2002:7f00:1::1",     # 6to4 → 127.0.0.1
        "2002:a9fe:a9fe::1",  # 6to4 → 169.254.169.254
    ],
)
def test_rejects_private_and_embedded_private_addresses(monkeypatch, address):
    resolve_to(monkeypatch, address)
    with pytest.raises(UnsafeUrlError):
        validate_public_url("https://evil.example.com/a.mp3")


def test_rejects_when_any_resolved_address_is_private(monkeypatch):
    """DNS 返回多个地址时，只要有一个私网就必须拒绝（防 DNS rebinding 式混合应答）。"""
    resolve_to(monkeypatch, "93.184.216.34", "10.0.0.5")
    with pytest.raises(UnsafeUrlError):
        validate_public_url("https://mixed.example.com/a.mp3")


@pytest.mark.parametrize("address", ["93.184.216.34", "1.1.1.1", "2606:2800:220:1:248:1893:25c8:1946", "198.18.0.5"])
def test_allows_public_and_fake_ip_pool_addresses(monkeypatch, address):
    resolve_to(monkeypatch, address)
    assert validate_public_url("https://cdn.example.com/a.mp3") == "https://cdn.example.com/a.mp3"


def test_unresolvable_host_is_a_resolution_error_not_a_policy_violation(monkeypatch):
    def boom(*args, **kwargs):
        raise socket.gaierror("nope")

    monkeypatch.setattr(ns.socket, "getaddrinfo", boom)
    with pytest.raises(UrlResolutionError):
        validate_public_url("https://gone.example.com/a.mp3")


class FakeResponse:
    def __init__(self, status=200, location=None):
        self.status_code = status
        self.headers = {"Location": location} if location else {}
        self.is_redirect = status in (301, 302, 303, 307, 308) and bool(location)
        self.is_permanent_redirect = status in (301, 308) and bool(location)

    def close(self):
        pass


def test_safe_get_revalidates_every_redirect_hop(monkeypatch):
    """公网 URL 302 到内网地址：第二跳必须被拒绝，请求不得发出。"""
    hosts = {"public.example.com": "93.184.216.34", "internal.example.com": "10.0.0.5"}

    def fake_getaddrinfo(host, port, type=0, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (hosts[host], port))]

    requested = []

    def fake_get(url, **kwargs):
        requested.append(url)
        return FakeResponse(302, location="http://internal.example.com/secret")

    monkeypatch.setattr(ns.socket, "getaddrinfo", fake_getaddrinfo)
    monkeypatch.setattr(ns.requests, "get", fake_get)

    with pytest.raises(UnsafeUrlError):
        safe_get("https://public.example.com/a.mp3")
    assert requested == ["https://public.example.com/a.mp3"]


def test_safe_get_rejects_redirect_to_non_http_scheme(monkeypatch):
    resolve_to(monkeypatch, "93.184.216.34")
    monkeypatch.setattr(ns.requests, "get", lambda url, **kw: FakeResponse(302, location="file:///etc/passwd"))

    with pytest.raises(UnsafeUrlError):
        safe_get("https://public.example.com/a.mp3")


def test_safe_get_gives_up_after_too_many_redirects(monkeypatch):
    resolve_to(monkeypatch, "93.184.216.34")
    monkeypatch.setattr(ns.requests, "get", lambda url, **kw: FakeResponse(302, location="https://public.example.com/loop"))

    with pytest.raises(requests.TooManyRedirects):
        safe_get("https://public.example.com/a.mp3", max_redirects=3)


def test_safe_get_never_lets_callers_enable_redirect_following(monkeypatch):
    resolve_to(monkeypatch, "93.184.216.34")
    seen = {}

    def fake_get(url, **kwargs):
        seen.update(kwargs)
        return FakeResponse(200)

    monkeypatch.setattr(ns.requests, "get", fake_get)
    safe_get("https://public.example.com/a.mp3", allow_redirects=True)
    assert seen["allow_redirects"] is False


def test_redact_url_drops_credentials_query_and_path():
    assert redact_url("https://u:p@cdn.example.com:8443/a.mp3?token=secret#x") == "https://cdn.example.com:8443"
