"""杂志封面：封面图提取、订阅持久化与封面图代理测试。"""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from app.standalone import app
from app import router as router_module
from modules import network_security
from modules.config import settings
from modules.rss_parser import RSSParser


# ── RSS 频道封面提取 ──


def test_extract_channel_image_from_itunes():
    feed = MagicMock()
    feed.feed = {"image": {"href": "https://cdn.example.com/cover.jpg"}}
    assert RSSParser._extract_channel_image(feed) == "https://cdn.example.com/cover.jpg"


def test_extract_channel_image_missing():
    feed = MagicMock()
    feed.feed = {"title": "no image here"}
    assert RSSParser._extract_channel_image(feed) == ""


# ── 订阅持久化封面 ──


def test_add_subscription_persists_image(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("read-podcast:\n  podcasts: []\n", encoding="utf-8")
    monkeypatch.setattr(settings, "CONFIG_PATH", config_path)
    monkeypatch.setattr(settings, "PODCASTS", [])
    # 放行 URL 校验，避免测试触发真实 DNS
    monkeypatch.setattr(router_module, "validate_public_url", lambda u: u)

    fake_parser = MagicMock()
    fake_parser.fetch_episodes.return_value = [{"title": "Ep1"}]
    fake_parser.channel_image = "https://cdn.example.com/feedcover.jpg"

    with patch("app.router.RSSParser", return_value=fake_parser):
        with TestClient(app) as client:
            res = client.post(
                "/api/read-podcast/subscriptions",
                json={"name": "封面播客", "rss_url": "https://example.com/feed.xml", "image": "https://cdn.example.com/art.jpg"},
            )
            assert res.status_code == 201

    saved = [p for p in settings.PODCASTS if p["name"] == "封面播客"]
    assert saved and saved[0]["image"] == "https://cdn.example.com/art.jpg"


def test_add_subscription_falls_back_to_channel_image(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("read-podcast:\n  podcasts: []\n", encoding="utf-8")
    monkeypatch.setattr(settings, "CONFIG_PATH", config_path)
    monkeypatch.setattr(settings, "PODCASTS", [])
    monkeypatch.setattr(router_module, "validate_public_url", lambda u: u)

    fake_parser = MagicMock()
    fake_parser.fetch_episodes.return_value = [{"title": "Ep1"}]
    fake_parser.channel_image = "https://cdn.example.com/feedcover.jpg"

    with patch("app.router.RSSParser", return_value=fake_parser):
        with TestClient(app) as client:
            res = client.post(
                "/api/read-podcast/subscriptions",
                json={"name": "无图播客", "rss_url": "https://example.com/feed.xml"},
            )
            assert res.status_code == 201

    saved = [p for p in settings.PODCASTS if p["name"] == "无图播客"]
    assert saved and saved[0]["image"] == "https://cdn.example.com/feedcover.jpg"


# ── 封面图代理 ──


class _FakeImageResponse:
    def __init__(self, content_type, body=b"IMG"):
        self.headers = {"Content-Type": content_type}
        self._body = body

    def raise_for_status(self):
        pass

    def iter_content(self, chunk_size=1):
        yield self._body

    def close(self):
        pass


def test_artwork_proxy_rejects_private_url():
    with TestClient(app) as client:
        res = client.get("/api/read-podcast/artwork", params={"url": "http://127.0.0.1/cover.png"})
        assert res.status_code == 400


def test_artwork_proxy_streams_image(monkeypatch):
    monkeypatch.setattr(router_module, "validate_public_url", lambda u: u)
    monkeypatch.setattr(network_security, "safe_get", lambda url, **kw: _FakeImageResponse("image/png", b"PNGDATA"))

    with TestClient(app) as client:
        res = client.get("/api/read-podcast/artwork", params={"url": "https://cdn.example.com/cover.png"})
        assert res.status_code == 200
        assert res.headers["content-type"] == "image/png"
        assert res.content == b"PNGDATA"
        assert "max-age" in res.headers.get("cache-control", "")


def test_artwork_proxy_rejects_non_image(monkeypatch):
    monkeypatch.setattr(router_module, "validate_public_url", lambda u: u)
    monkeypatch.setattr(network_security, "safe_get", lambda url, **kw: _FakeImageResponse("text/html"))

    with TestClient(app) as client:
        res = client.get("/api/read-podcast/artwork", params={"url": "https://cdn.example.com/notimage"})
        assert res.status_code == 415
