"""关键概念抽取 + 维基百科链接的测试。

不打真实网络：AI 与维基百科 API 都以假客户端替身注入。
"""
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from modules import wikipedia as wiki
from modules.wikipedia import (
    WikipediaError,
    _parse_candidates,
    _titles_related,
    collect_concepts,
    lookup_concept,
)


class _FakeClient:
    """按 URL 关键字返回预置 JSON 的 httpx.Client 替身。"""

    def __init__(self, pages=None, searches=None, lang="zh"):
        self.pages = pages or {}       # 词条标题 -> summary JSON
        self.searches = searches or {} # 搜索词  -> 结果标题列表
        self.lang = lang               # 只有这个语言站点有内容
        self.calls = []

    def _lang_of(self, url):
        return url.split("//", 1)[-1].split(".", 1)[0]

    def get(self, url, params=None):
        self.calls.append((url, params or {}))
        if self._lang_of(url) != self.lang:
            return _Resp(None, 404)
        if "/page/summary/" in url:
            from urllib.parse import unquote
            title = unquote(url.rsplit("/", 1)[-1]).replace("_", " ")
            payload = self.pages.get(title)
            return _Resp(payload, 200 if payload else 404)
        titles = self.searches.get((params or {}).get("srsearch"), [])
        return _Resp({"query": {"search": [{"title": t} for t in titles]}}, 200)


class _Resp:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def _page(title, extract="摘要", lang="zh"):
    return {
        "title": title,
        "extract": extract,
        "type": "standard",
        "content_urls": {"desktop": {"page": f"https://{lang}.wikipedia.org/wiki/{title}"}},
    }


# ── 候选解析 ──


def test_parse_candidates_accepts_plain_json():
    items = _parse_candidates('[{"term": "OpenAI", "reason": "本期主角"}]')
    assert items == [{"term": "OpenAI", "reason": "本期主角"}]


def test_parse_candidates_strips_code_fence_and_prose():
    raw = '好的，结果如下：\n```json\n[{"term": "图灵测试"}]\n```'
    assert _parse_candidates(raw) == [{"term": "图灵测试", "reason": ""}]


def test_parse_candidates_dedupes_case_insensitively():
    items = _parse_candidates('["OpenAI", "openai", "Anthropic"]')
    assert [i["term"] for i in items] == ["OpenAI", "Anthropic"]


def test_parse_candidates_rejects_non_json():
    with pytest.raises(WikipediaError):
        _parse_candidates("我没法给出列表")


# ── 标题相关性（防止链到不相干的词条）──


@pytest.mark.parametrize(
    "term, candidate, expected",
    [
        ("量子计算", "量子计算机", True),   # 前缀扩展，应接受
        ("OpenAI", "OpenAI", True),
        ("斯坦福大学", "斯坦福大学（美国）", True),  # 消歧义括号忽略
        ("阿尔法折叠", "CASP", False),      # 全文搜索的噪音，必须拒绝
        ("AI", "AIDS", False),              # 过短的词不做子串匹配
        ("强化学习", "机器学习", False),
    ],
)
def test_titles_related(term, candidate, expected):
    assert _titles_related(term, candidate) is expected


# ── 单词条核对 ──


def test_lookup_prefers_direct_title_over_search():
    client = _FakeClient(pages={"OpenAI": _page("OpenAI")})
    found = lookup_concept(client, "OpenAI", lang="zh")
    assert found["title"] == "OpenAI"
    # 直查命中就不该再走搜索接口
    assert all("/w/api.php" not in url for url, _ in client.calls)


def test_lookup_falls_back_to_validated_search():
    client = _FakeClient(
        pages={"量子计算机": _page("量子计算机")},
        searches={"量子计算": ["量子计算机"]},
    )
    found = lookup_concept(client, "量子计算", lang="zh")
    assert found["title"] == "量子计算机"


def test_lookup_rejects_unrelated_search_hit():
    """搜索返回沾边页面时应放弃，而不是给出错误链接。"""
    client = _FakeClient(pages={"CASP": _page("CASP")}, searches={"阿尔法折叠": ["CASP"]})
    assert lookup_concept(client, "阿尔法折叠", lang="zh") is None


def test_lookup_skips_disambiguation_pages():
    client = _FakeClient(pages={"苹果": {**_page("苹果"), "type": "disambiguation"}})
    assert lookup_concept(client, "苹果", lang="zh") is None


def test_lookup_falls_back_to_second_language():
    """中文站没有该词条时应退到英文站。"""
    client = _FakeClient(pages={"AlphaFold": _page("AlphaFold", lang="en")}, lang="en")
    found = lookup_concept(client, "AlphaFold", lang="zh", fallback_lang="en")
    assert found["lang"] == "en"


# ── 端到端（AI 与网络均为替身）──


def _patch_pipeline(monkeypatch, candidates, client):
    monkeypatch.setattr(wiki, "chat_completion", lambda *a, **k: candidates)
    monkeypatch.setattr(wiki.httpx, "Client", lambda **kwargs: _CM(client))


class _CM:
    def __init__(self, client):
        self.client = client

    def __enter__(self):
        return self.client

    def __exit__(self, *exc):
        return False


def test_collect_concepts_drops_unverifiable_terms(monkeypatch):
    client = _FakeClient(
        pages={"OpenAI": _page("OpenAI")},
        searches={"这家公司": [], "OpenAI": ["OpenAI"]},
    )
    _patch_pipeline(monkeypatch, '["OpenAI", "这家公司"]', client)

    result = collect_concepts("标题", "播客", "正文", {}, lang="zh", fallback_lang="")
    terms = [c["term"] for c in result["concepts"]]
    assert terms == ["OpenAI"]
    assert result["proposed"] == 2


def test_collect_concepts_preserves_ai_ordering(monkeypatch):
    pages = {name: _page(name) for name in ["甲", "乙", "丙"]}
    client = _FakeClient(pages=pages)
    _patch_pipeline(monkeypatch, '["甲", "乙", "丙"]', client)

    result = collect_concepts("t", "p", "正文", {}, lang="zh", fallback_lang="")
    assert [c["term"] for c in result["concepts"]] == ["甲", "乙", "丙"]


def test_collect_concepts_dedupes_same_page(monkeypatch):
    """不同提名词命中同一词条时只保留一条。"""
    client = _FakeClient(
        pages={"OpenAI": _page("OpenAI")},
        searches={"Open AI": ["OpenAI"]},
    )
    _patch_pipeline(monkeypatch, '["OpenAI", "Open AI"]', client)

    result = collect_concepts("t", "p", "正文", {}, lang="zh", fallback_lang="")
    assert len(result["concepts"]) == 1


def test_collect_concepts_respects_limit(monkeypatch):
    pages = {f"词{i}": _page(f"词{i}") for i in range(10)}
    client = _FakeClient(pages=pages)
    _patch_pipeline(monkeypatch, str([f"词{i}" for i in range(10)]).replace("'", '"'), client)

    result = collect_concepts("t", "p", "正文", {}, lang="zh", fallback_lang="", limit=5)
    assert len(result["concepts"]) == 5


def test_collect_concepts_rejects_empty_transcript():
    with pytest.raises(WikipediaError, match="文字稿为空"):
        collect_concepts("t", "p", "   ", {})


def test_collect_concepts_rejects_bad_language():
    with pytest.raises(WikipediaError, match="语言代码"):
        collect_concepts("t", "p", "正文", {}, lang="zh; rm -rf /")


# ── 端点 /tasks/{id}/concepts ──


def _make_task(tmp_path, body="## 正文\n\nOpenAI 与强化学习。"):
    from app.models.task import Task, TaskStatus

    output = tmp_path / "note.md"
    output.write_text(f"---\ntitle: 测试\n---\n\n{body}", encoding="utf-8")
    return Task(
        id="t1",
        podcast_name="示例播客",
        episode_title="第一期",
        status=TaskStatus.SUCCESS,
        output_path=str(output),
    )


def test_concepts_endpoint_returns_verified_links(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock
    from fastapi.testclient import TestClient
    from app.standalone import app
    from app import router as router_module

    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=_make_task(tmp_path)))
    captured = {}

    def fake_collect(title, podcast, transcript, config, **kwargs):
        captured.update({"title": title, "podcast": podcast, "transcript": transcript, **kwargs})
        return {
            "concepts": [
                {
                    "term": "OpenAI",
                    "reason": "本期主角",
                    "wikipedia_title": "OpenAI",
                    "url": "https://zh.wikipedia.org/wiki/OpenAI",
                    "summary": "一家公司",
                    "lang": "zh",
                }
            ],
            "proposed": 3,
            "lang": "zh",
            "fallback_lang": "en",
        }

    monkeypatch.setattr(router_module, "collect_concepts", fake_collect)

    with TestClient(app) as client:
        res = client.post("/api/read-podcast/tasks/t1/concepts", json={})
        assert res.status_code == 200
        data = res.json()

    assert data["concepts"][0]["url"] == "https://zh.wikipedia.org/wiki/OpenAI"
    assert data["cached"] is False
    assert captured["title"] == "第一期"
    assert captured["podcast"] == "示例播客"
    # frontmatter 已剥离
    assert "title: 测试" not in captured["transcript"]


def test_concepts_endpoint_caches_between_calls(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock
    from fastapi.testclient import TestClient
    from app.standalone import app
    from app import router as router_module

    router_module._concepts_cache.clear()
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=_make_task(tmp_path)))
    calls = []

    def fake_collect(*a, **k):
        calls.append(1)
        return {"concepts": [], "proposed": 0, "lang": "zh", "fallback_lang": "en"}

    monkeypatch.setattr(router_module, "collect_concepts", fake_collect)

    with TestClient(app) as client:
        first = client.post("/api/read-podcast/tasks/t1/concepts", json={})
        second = client.post("/api/read-podcast/tasks/t1/concepts", json={})
        third = client.post("/api/read-podcast/tasks/t1/concepts", json={"refresh": True})

    assert first.json()["cached"] is False
    assert second.json()["cached"] is True
    assert third.json()["cached"] is False
    assert len(calls) == 2  # 第二次命中缓存，refresh 强制重算


def test_concepts_endpoint_rejects_out_of_range_limit(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock
    from fastapi.testclient import TestClient
    from app.standalone import app
    from app import router as router_module

    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=_make_task(tmp_path)))
    with TestClient(app) as client:
        assert client.post("/api/read-podcast/tasks/t1/concepts", json={"limit": 99}).status_code == 422
        assert client.post("/api/read-podcast/tasks/t1/concepts", json={"limit": 1}).status_code == 422


def test_concepts_endpoint_empty_transcript_returns_422(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock
    from fastapi.testclient import TestClient
    from app.standalone import app
    from app import router as router_module

    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=_make_task(tmp_path, body="")))
    with TestClient(app) as client:
        res = client.post("/api/read-podcast/tasks/t1/concepts", json={})
    assert res.status_code == 422


def test_concepts_endpoint_unconfigured_ai_returns_503(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock
    from fastapi.testclient import TestClient
    from app.standalone import app
    from app import router as router_module

    router_module._concepts_cache.clear()
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=_make_task(tmp_path)))

    def boom(*a, **k):
        raise WikipediaError("未配置 AI 服务商")

    monkeypatch.setattr(router_module, "collect_concepts", boom)
    with TestClient(app) as client:
        res = client.post("/api/read-podcast/tasks/t1/concepts", json={})
    assert res.status_code == 503


def test_concepts_endpoint_unknown_task_returns_404(monkeypatch):
    from unittest.mock import AsyncMock
    from fastapi.testclient import TestClient
    from app.standalone import app
    from app import router as router_module

    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=None))
    with TestClient(app) as client:
        res = client.post("/api/read-podcast/tasks/nope/concepts", json={})
    assert res.status_code == 404
