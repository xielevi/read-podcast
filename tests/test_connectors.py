"""文件连接器：模块与端点测试。"""
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from app.standalone import app
from app import router as router_module
from modules import connectors as connectors_module
from modules.config import settings
from modules.connectors import (
    ConnectorError,
    available_connectors,
    build_payload,
    find_connector,
    send_document,
)
from modules.connectors import test_connector as run_test_connector


class _JsonResp:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


# ── 模块 ──


def test_available_connectors_marks_configured(monkeypatch):
    monkeypatch.delenv("READ_PODCAST_CONNECTOR_FEISHU_URL", raising=False)
    config = [
        {"name": "飞书群", "format": "feishu", "url_env": "READ_PODCAST_CONNECTOR_FEISHU_URL"},
        {"name": "坏的", "format": "unknown", "url_env": "X"},
    ]
    result = available_connectors(config)
    assert len(result) == 1
    assert result[0]["name"] == "飞书群"
    assert result[0]["configured"] is False

    monkeypatch.setenv("READ_PODCAST_CONNECTOR_FEISHU_URL", "https://open.feishu.cn/hook/x")
    assert available_connectors(config)[0]["configured"] is True


def test_build_payload_formats_and_truncation():
    doc = {"title": "标题", "podcast": "某播客", "markdown": "正文内容", "source_link": "https://e/x"}

    feishu, trunc = build_payload("feishu", doc, max_chars=1000)
    assert feishu["msg_type"] == "text"
    assert "标题" in feishu["content"]["text"]
    assert trunc is False

    ding, _ = build_payload("dingtalk", doc, max_chars=1000)
    assert ding["msgtype"] == "markdown"
    assert ding["markdown"]["title"] == "标题"

    generic, _ = build_payload("markdown", doc, max_chars=1000)
    assert generic["markdown"] == "正文内容"
    assert generic["source_link"] == "https://e/x"

    _body, truncated = build_payload("feishu", {"markdown": "x" * 50}, max_chars=10)
    assert truncated is True


def test_send_document_requires_configured_url(monkeypatch):
    monkeypatch.delenv("READ_PODCAST_CONNECTOR_X", raising=False)
    connector = {"name": "X", "format": "feishu", "url_env": "READ_PODCAST_CONNECTOR_X"}
    with pytest.raises(ConnectorError, match="未设置"):
        send_document(connector, {"title": "t", "markdown": "m"})


def test_send_document_posts_and_checks_business_code(monkeypatch):
    monkeypatch.setenv("READ_PODCAST_CONNECTOR_X", "https://open.feishu.cn/hook/x")
    monkeypatch.setattr(connectors_module, "validate_public_url", lambda url: url)

    class _Resp:
        status_code = 200

        def __init__(self, payload):
            self._payload = payload

        def json(self):
            return self._payload

    captured = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        return _Resp({"code": 0})

    monkeypatch.setattr(connectors_module.httpx, "post", fake_post)
    connector = {"name": "飞书群", "format": "feishu", "url_env": "READ_PODCAST_CONNECTOR_X"}
    result = send_document(connector, {"title": "标题", "markdown": "正文"})
    assert result["ok"] is True
    assert captured["url"] == "https://open.feishu.cn/hook/x"

    # 业务错误码 → 失败
    def fake_post_err(url, json=None, headers=None, timeout=None):
        return _Resp({"code": 19021, "msg": "sign match fail"})

    monkeypatch.setattr(connectors_module.httpx, "post", fake_post_err)
    with pytest.raises(ConnectorError, match="sign match fail"):
        send_document(connector, {"title": "t", "markdown": "m"})


def test_send_document_rejects_unsafe_url(monkeypatch):
    monkeypatch.setenv("READ_PODCAST_CONNECTOR_X", "http://127.0.0.1/hook")
    connector = {"name": "X", "format": "feishu", "url_env": "READ_PODCAST_CONNECTOR_X"}
    with pytest.raises(ConnectorError, match="不安全"):
        send_document(connector, {"title": "t", "markdown": "m"})


# ── 云文档：Notion ──


def test_available_connectors_notion_kind_and_configured(monkeypatch):
    monkeypatch.delenv("NOTION_TOKEN", raising=False)
    config = [{"name": "知识库", "format": "notion", "token_env": "NOTION_TOKEN", "database_id": "db1"}]
    result = available_connectors(config)
    assert result[0]["kind"] == "doc"
    assert result[0]["configured"] is False
    monkeypatch.setenv("NOTION_TOKEN", "secret_x")
    assert available_connectors(config)[0]["configured"] is True
    # 缺少 database_id/page_id → 未配置
    no_target = [{"name": "x", "format": "notion", "token_env": "NOTION_TOKEN"}]
    assert available_connectors(no_target)[0]["configured"] is False


def test_send_notion_creates_page(monkeypatch):
    monkeypatch.setenv("NOTION_TOKEN", "secret_x")
    monkeypatch.setattr(connectors_module, "validate_public_url", lambda url: url)
    captured = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        return _JsonResp({"url": "https://notion.so/page-abc"})

    monkeypatch.setattr(connectors_module.httpx, "post", fake_post)
    connector = {
        "name": "知识库",
        "format": "notion",
        "token_env": "NOTION_TOKEN",
        "database_id": "db1",
        "title_property": "标题",
    }
    doc = {"title": "第一期", "markdown": "## 核心观点\n\nAgent 已落地。\n- 案例一"}
    result = send_document(connector, doc)

    assert result["ok"] is True and result["kind"] == "doc"
    assert result["document_url"] == "https://notion.so/page-abc"
    assert captured["url"] == "https://api.notion.com/v1/pages"
    assert captured["headers"]["Authorization"] == "Bearer secret_x"
    assert captured["json"]["parent"] == {"database_id": "db1"}
    assert "标题" in captured["json"]["properties"]
    # 结构化：标题块 + 段落 + 列表
    types = [child["type"] for child in captured["json"]["children"]]
    assert "heading_2" in types and "bulleted_list_item" in types


def test_send_notion_page_parent_uses_title_key(monkeypatch):
    monkeypatch.setenv("NOTION_TOKEN", "secret_x")
    monkeypatch.setattr(connectors_module, "validate_public_url", lambda url: url)
    captured = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["json"] = json
        return _JsonResp({"url": "https://notion.so/p"})

    monkeypatch.setattr(connectors_module.httpx, "post", fake_post)
    connector = {"name": "kb", "format": "notion", "token_env": "NOTION_TOKEN", "page_id": "pg1"}
    send_document(connector, {"title": "T", "markdown": "正文"})
    assert captured["json"]["parent"] == {"page_id": "pg1"}
    assert "title" in captured["json"]["properties"]


def test_send_notion_error_raises(monkeypatch):
    monkeypatch.setenv("NOTION_TOKEN", "secret_x")
    monkeypatch.setattr(connectors_module, "validate_public_url", lambda url: url)
    monkeypatch.setattr(
        connectors_module.httpx,
        "post",
        lambda *a, **k: _JsonResp({"message": "unauthorized"}, status_code=401),
    )
    connector = {"name": "kb", "format": "notion", "token_env": "NOTION_TOKEN", "database_id": "db1"}
    with pytest.raises(ConnectorError, match="unauthorized"):
        send_document(connector, {"title": "T", "markdown": "m"})


# ── 云文档：飞书 Docx ──


def test_send_feishu_doc_token_create_insert_sequence(monkeypatch):
    monkeypatch.setenv("FEISHU_APP_ID", "cli_x")
    monkeypatch.setenv("FEISHU_APP_SECRET", "sec_x")
    monkeypatch.setattr(connectors_module, "validate_public_url", lambda url: url)
    calls = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append(url)
        if url.endswith("/tenant_access_token/internal"):
            assert json == {"app_id": "cli_x", "app_secret": "sec_x"}
            return _JsonResp({"code": 0, "tenant_access_token": "t-abc"})
        if url.endswith("/docx/v1/documents"):
            assert headers["Authorization"] == "Bearer t-abc"
            return _JsonResp({"code": 0, "data": {"document": {"document_id": "doc123"}}})
        # 插入内容
        assert "/documents/doc123/blocks/doc123/children" in url
        assert json["children"] and json["children"][0]["block_type"] == 2
        return _JsonResp({"code": 0, "data": {}})

    monkeypatch.setattr(connectors_module.httpx, "post", fake_post)
    connector = {
        "name": "飞书文档",
        "format": "feishu-doc",
        "app_id_env": "FEISHU_APP_ID",
        "app_secret_env": "FEISHU_APP_SECRET",
    }
    result = send_document(connector, {"title": "第一期", "markdown": "第一段\n第二段"})
    assert result["ok"] is True
    assert result["document_id"] == "doc123"
    assert len(calls) == 3


def test_send_feishu_doc_token_failure(monkeypatch):
    monkeypatch.setenv("FEISHU_APP_ID", "cli_x")
    monkeypatch.setenv("FEISHU_APP_SECRET", "bad")
    monkeypatch.setattr(connectors_module, "validate_public_url", lambda url: url)
    monkeypatch.setattr(
        connectors_module.httpx,
        "post",
        lambda *a, **k: _JsonResp({"code": 10003, "msg": "app secret invalid"}),
    )
    connector = {
        "name": "飞书文档",
        "format": "feishu-doc",
        "app_id_env": "FEISHU_APP_ID",
        "app_secret_env": "FEISHU_APP_SECRET",
    }
    with pytest.raises(ConnectorError, match="app secret invalid"):
        send_document(connector, {"title": "T", "markdown": "m"})


# ── 预检 test_connector ──


def test_test_connector_notion(monkeypatch):
    monkeypatch.setenv("NOTION_TOKEN", "secret_x")
    monkeypatch.setattr(connectors_module, "validate_public_url", lambda url: url)
    monkeypatch.setattr(connectors_module.httpx, "get", lambda *a, **k: _JsonResp({"object": "user"}))
    connector = {"name": "kb", "format": "notion", "token_env": "NOTION_TOKEN", "database_id": "db1"}
    result = run_test_connector(connector)
    assert result["ok"] is True


def test_test_connector_webhook_cannot_ping(monkeypatch):
    monkeypatch.setenv("HOOK", "https://open.feishu.cn/hook/x")
    monkeypatch.setattr(connectors_module, "validate_public_url", lambda url: url)
    connector = {"name": "群", "format": "feishu", "url_env": "HOOK"}
    result = run_test_connector(connector)
    assert result["ok"] is True
    assert "预检" in result["detail"]


# ── 端点 ──


def test_get_connectors_endpoint(monkeypatch):
    monkeypatch.setattr(
        settings,
        "CONNECTORS",
        [{"name": "飞书群", "format": "feishu", "url_env": "READ_PODCAST_CONNECTOR_FEISHU_URL"}],
    )
    monkeypatch.delenv("READ_PODCAST_CONNECTOR_FEISHU_URL", raising=False)
    with TestClient(app) as client:
        res = client.get("/api/read-podcast/connectors")
        assert res.status_code == 200
        data = res.json()
        assert data[0]["name"] == "飞书群"
        assert data[0]["configured"] is False


def test_export_task_sends(tmp_path, monkeypatch):
    from app.models.task import Task, TaskStatus

    output = tmp_path / "note.md"
    output.write_text(
        "---\ntitle: 测试\nsource_link: https://example.com/ep1\n---\n\n## 正文\n\n内容。",
        encoding="utf-8",
    )
    task = Task(
        id="t1",
        podcast_name="示例播客",
        episode_title="第一期",
        status=TaskStatus.SUCCESS,
        output_path=str(output),
    )
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=task))
    monkeypatch.setattr(
        settings,
        "CONNECTORS",
        [{"name": "飞书群", "format": "feishu", "url_env": "READ_PODCAST_CONNECTOR_FEISHU_URL"}],
    )

    captured = {}

    def fake_send(connector, doc, **kwargs):
        captured["connector"] = connector
        captured["doc"] = doc
        return {"connector": connector["name"], "format": "feishu", "truncated": False, "ok": True}

    monkeypatch.setattr(router_module, "send_document", fake_send)

    with TestClient(app) as client:
        res = client.post("/api/read-podcast/tasks/t1/export", json={"connector": "飞书群"})
        assert res.status_code == 200
        assert res.json()["status"] == "sent"

    assert captured["doc"]["title"] == "第一期"
    assert captured["doc"]["podcast"] == "示例播客"
    assert captured["doc"]["source_link"] == "https://example.com/ep1"
    # frontmatter 已剥离
    assert "title: 测试" not in captured["doc"]["markdown"]
    assert "## 正文" in captured["doc"]["markdown"]


def test_export_task_unknown_connector(monkeypatch):
    from app.models.task import Task, TaskStatus

    task = Task(id="t2", podcast_name="P", episode_title="E", status=TaskStatus.SUCCESS, output_path="/x.md")
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=task))
    monkeypatch.setattr(settings, "CONNECTORS", [])
    with TestClient(app) as client:
        res = client.post("/api/read-podcast/tasks/t2/export", json={"connector": "不存在"})
        assert res.status_code == 404


def test_export_task_connector_failure_returns_502(tmp_path, monkeypatch):
    from app.models.task import Task, TaskStatus

    output = tmp_path / "note.md"
    output.write_text("---\ntitle: x\n---\n\n正文", encoding="utf-8")
    task = Task(id="t3", podcast_name="P", episode_title="E", status=TaskStatus.SUCCESS, output_path=str(output))
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=task))
    monkeypatch.setattr(
        settings, "CONNECTORS", [{"name": "群", "format": "feishu", "url_env": "X"}]
    )

    def fake_send(connector, doc, **kwargs):
        raise ConnectorError("目标返回失败：boom")

    monkeypatch.setattr(router_module, "send_document", fake_send)
    with TestClient(app) as client:
        res = client.post("/api/read-podcast/tasks/t3/export", json={"connector": "群"})
        assert res.status_code == 502
        assert "boom" in res.json()["detail"]


def test_export_task_summary_mode_builds_knowledge_entry(tmp_path, monkeypatch):
    from app.models.task import Task, TaskStatus

    output = tmp_path / "note.md"
    output.write_text("---\ntitle: 测试\n---\n\n## 正文\n\n嘉宾聊了 Agent 的落地。", encoding="utf-8")
    task = Task(id="t9", podcast_name="示例", episode_title="第九期", status=TaskStatus.SUCCESS, output_path=str(output))
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=task))
    monkeypatch.setattr(settings, "CONNECTORS", [{"name": "知识库", "format": "notion", "token_env": "NOTION_TOKEN", "database_id": "db1"}])

    captured = {}

    def fake_chat(messages, config, **kwargs):
        captured["system"] = messages[0]["content"]
        return "## 核心观点\n\nAgent 已进入真实业务。"

    def fake_send(connector, doc, **kwargs):
        captured["doc"] = doc
        return {"connector": connector["name"], "format": "notion", "kind": "doc", "truncated": False, "ok": True}

    monkeypatch.setattr(router_module, "chat_completion", fake_chat)
    monkeypatch.setattr(router_module, "send_document", fake_send)

    with TestClient(app) as client:
        res = client.post("/api/read-podcast/tasks/t9/export", json={"connector": "知识库", "mode": "summary"})
        assert res.status_code == 200
        assert res.json()["mode"] == "summary"

    assert "核心观点" in captured["system"]
    assert "知识条目" in captured["doc"]["markdown"]
    assert "Agent 已进入真实业务" in captured["doc"]["markdown"]


def test_export_summary_mode_unconfigured_ai_returns_503(tmp_path, monkeypatch):
    from app.models.task import Task, TaskStatus

    output = tmp_path / "note.md"
    output.write_text("---\ntitle: x\n---\n\n正文内容。", encoding="utf-8")
    task = Task(id="t10", podcast_name="P", episode_title="E", status=TaskStatus.SUCCESS, output_path=str(output))
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=task))
    monkeypatch.setattr(settings, "CONNECTORS", [{"name": "群", "format": "feishu", "url_env": "X"}])

    def fake_chat(messages, config, **kwargs):
        raise ConnectorError  # not used

    def fake_chat_err(messages, config, **kwargs):
        from modules.refiner import AssistantError

        raise AssistantError("未设置 REFINER_API_KEY，请在 .env 中填写后重试。")

    monkeypatch.setattr(router_module, "chat_completion", fake_chat_err)
    with TestClient(app) as client:
        res = client.post("/api/read-podcast/tasks/t10/export", json={"connector": "群", "mode": "summary"})
        assert res.status_code == 503


def test_connector_test_endpoint(monkeypatch):
    monkeypatch.setattr(settings, "CONNECTORS", [{"name": "知识库", "format": "notion", "token_env": "NOTION_TOKEN", "database_id": "db1"}])
    monkeypatch.setattr(router_module, "precheck_connector", lambda connector, **kw: {"connector": connector["name"], "ok": True, "detail": "Notion 凭据有效"})
    with TestClient(app) as client:
        ok = client.post("/api/read-podcast/connectors/知识库/test")
        assert ok.status_code == 200
        assert ok.json()["ok"] is True
        missing = client.post("/api/read-podcast/connectors/不存在/test")
        assert missing.status_code == 404


def test_connector_test_endpoint_failure_returns_502(monkeypatch):
    monkeypatch.setattr(settings, "CONNECTORS", [{"name": "kb", "format": "notion", "token_env": "NOTION_TOKEN", "database_id": "db1"}])

    def fake_precheck(connector, **kw):
        raise ConnectorError("Notion 预检失败：HTTP 401")

    monkeypatch.setattr(router_module, "precheck_connector", fake_precheck)
    with TestClient(app) as client:
        res = client.post("/api/read-podcast/connectors/kb/test")
        assert res.status_code == 502
