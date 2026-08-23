from pathlib import Path

import pytest
import requests

from modules import rss_parser as rss_module
from modules.config import ConfigurationError, Settings, read_int_config
from modules.network_security import OUTBOUND_USER_AGENT
from modules.rss_parser import RSSParser


class FakeRssResponse:
    def __init__(self, payload: bytes):
        self.payload = payload
        self.headers = {}
        self.closed = False

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size: int):
        yield self.payload

    def close(self):
        self.closed = True


RSS_DOCUMENT = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Example</title>
    <item>
      <guid>episode-1</guid>
      <title>Episode 1</title>
      <itunes:duration>120</itunes:duration>
      <enclosure url="https://cdn.example.com/episode.mp3" type="audio/mpeg" />
    </item>
  </channel>
</rss>
"""


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ("runtime: [", "无法读取配置文件"),
        ("- runtime", "顶层必须是映射"),
        ("runtime: []", "配置段 runtime 必须是映射"),
        ("read-podcast: []", "命名空间必须是映射"),
    ],
)
def test_settings_rejects_invalid_yaml_shapes(tmp_path: Path, content: str, message: str):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(content, encoding="utf-8")

    with pytest.raises(ConfigurationError, match=message):
        Settings(config_path)


def test_integer_config_reports_invalid_value_by_name():
    assert read_int_config({"max_rss_bytes": "2048"}, "max_rss_bytes", 1024) == 2048

    with pytest.raises(ConfigurationError, match="max_rss_bytes"):
        read_int_config({"max_rss_bytes": "many"}, "max_rss_bytes", 1024)
    with pytest.raises(ConfigurationError, match="不能是布尔值"):
        read_int_config({"max_rss_bytes": True}, "max_rss_bytes", 1024)


def test_settings_normalizes_runtime_integers_and_rejects_bad_values(tmp_path: Path):
    valid_path = tmp_path / "valid.yaml"
    valid_path.write_text("runtime:\n  max_rss_bytes: '2048'\n", encoding="utf-8")
    assert Settings(valid_path).RUNTIME_CONFIG["max_rss_bytes"] == 2048

    invalid_path = tmp_path / "invalid.yaml"
    invalid_path.write_text("runtime:\n  download_concurrency: many\n", encoding="utf-8")
    with pytest.raises(ConfigurationError, match="download_concurrency"):
        Settings(invalid_path)


def test_rss_tls_fallback_is_explicit_and_closes_response(monkeypatch):
    parser = RSSParser("https://example.com/feed.xml", "Example", insecure_tls=True)
    response = FakeRssResponse(RSS_DOCUMENT)
    calls = []

    def fake_get(headers, *, verify):
        calls.append((verify, headers))
        if verify:
            raise requests.exceptions.SSLError("certificate failed")
        return response

    monkeypatch.setattr(parser, "_get", fake_get)

    episodes = parser.fetch_episodes()

    assert [verify for verify, _headers in calls] == [True, False]
    assert all(headers["User-Agent"] == OUTBOUND_USER_AGENT for _verify, headers in calls)
    assert response.closed is True
    assert [episode["id"] for episode in episodes] == ["episode-1"]


def test_rss_tls_fallback_failure_does_not_escape(monkeypatch):
    parser = RSSParser("https://example.com/feed.xml", "Example", insecure_tls=True)
    calls = []

    def fake_get(_headers, *, verify):
        calls.append(verify)
        if verify:
            raise requests.exceptions.SSLError("certificate failed")
        raise requests.exceptions.Timeout("fallback timed out")

    monkeypatch.setattr(parser, "_get", fake_get)

    assert parser.fetch_episodes() == []
    assert calls == [True, False]


def test_rss_does_not_downgrade_tls_unless_subscription_allows_it(monkeypatch):
    parser = RSSParser("https://example.com/feed.xml", "Example")
    calls = []

    def fake_get(_headers, *, verify):
        calls.append(verify)
        raise requests.exceptions.SSLError("certificate failed")

    monkeypatch.setattr(parser, "_get", fake_get)

    assert parser.fetch_episodes() == []
    assert calls == [True]


def test_rss_response_closes_when_size_limit_fails(monkeypatch):
    parser = RSSParser("https://example.com/feed.xml", "Example")
    response = FakeRssResponse(b"too large")
    monkeypatch.setattr(rss_module, "MAX_RSS_BYTES", 4)
    monkeypatch.setattr(parser, "_get", lambda _headers, *, verify: response)

    assert parser.fetch_episodes() == []
    assert response.closed is True


def test_rss_string_false_does_not_enable_insecure_tls(monkeypatch):
    # 手改 YAML 写成 insecure_tls: "false" 不能被当成显式开启。
    parser = RSSParser("https://example.com/feed.xml", "Example", insecure_tls="false")
    assert parser.insecure_tls is False

    calls = []

    def fake_get(_headers, *, verify):
        calls.append(verify)
        raise requests.exceptions.SSLError("certificate failed")

    monkeypatch.setattr(parser, "_get", fake_get)

    assert parser.fetch_episodes() == []
    assert calls == [True]


def test_settings_rejects_non_mapping_openai_section(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "transcription:\n  openai:\n    - key: value\n", encoding="utf-8"
    )
    with pytest.raises(ConfigurationError, match="transcription.openai 必须是映射"):
        Settings(config_path)


def test_pipeline_propagates_insecure_tls_to_parser(monkeypatch):
    from modules.pipeline import PodcastPipeline

    pipeline = PodcastPipeline.__new__(PodcastPipeline)
    pipeline.podcast_config = lambda name: {
        "rss_url": "https://example.com/feed.xml",
        "name": name,
        "insecure_tls": True,
    }

    captured = {}

    class DummyParser:
        def __init__(self, rss_url, name, insecure_tls=False):
            captured["insecure_tls"] = insecure_tls

        def fetch_episodes(self, **_kwargs):
            return []

    monkeypatch.setattr("modules.pipeline.RSSParser", DummyParser)

    pipeline.fetch_episodes("Example")
    assert captured["insecure_tls"] is True
