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

    def fake_post(url, json=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        return _Resp({"code": 0})

    monkeypatch.setattr(connectors_module.httpx, "post", fake_post)
    connector = {"name": "飞书群", "format": "feishu", "url_env": "READ_PODCAST_CONNECTOR_X"}
    result = send_document(connector, {"title": "标题", "markdown": "正文"})
    assert result["ok"] is True
    assert captured["url"] == "https://open.feishu.cn/hook/x"

    # 业务错误码 → 失败
    def fake_post_err(url, json=None, timeout=None):
        return _Resp({"code": 19021, "msg": "sign match fail"})

    monkeypatch.setattr(connectors_module.httpx, "post", fake_post_err)
    with pytest.raises(ConnectorError, match="sign match fail"):
        send_document(connector, {"title": "t", "markdown": "m"})


def test_send_document_rejects_unsafe_url(monkeypatch):
    monkeypatch.setenv("READ_PODCAST_CONNECTOR_X", "http://127.0.0.1/hook")
    connector = {"name": "X", "format": "feishu", "url_env": "READ_PODCAST_CONNECTOR_X"}
    with pytest.raises(ConnectorError, match="不安全"):
        send_document(connector, {"title": "t", "markdown": "m"})


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
