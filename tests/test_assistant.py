"""AI 阅读助手（百科查询 + 文字稿问答）的测试。"""
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
from modules.refiner import AssistantError, assistant_available, chat_completion


# ── refiner.chat_completion ──


class _FakeResponse:
    def __init__(self, *, json_data=None, status_code=200):
        self._json = json_data or {}
        self.status_code = status_code

    def json(self):
        return self._json


def test_assistant_available_requires_provider_and_key(monkeypatch):
    monkeypatch.delenv("REFINER_API_KEY", raising=False)
    assert not assistant_available({"api_base": "https://x/v1", "model": "m"})
    monkeypatch.setenv("REFINER_API_KEY", "sk-x")
    assert assistant_available({"api_base": "https://x/v1", "model": "m"})
    assert not assistant_available({"api_base": "", "model": "m"})


def test_chat_completion_returns_content(monkeypatch):
    import httpx

    monkeypatch.setenv("REFINER_API_KEY", "sk-x")

    def fake_post(url, headers=None, json=None, timeout=None):
        assert url == "https://x/v1/chat/completions"
        assert json["messages"][-1]["content"] == "你好"
        return _FakeResponse(json_data={"choices": [{"message": {"content": "回答内容"}}]})

    monkeypatch.setattr(httpx, "post", fake_post)

    out = chat_completion(
        [{"role": "user", "content": "你好"}],
        {"api_base": "https://x/v1", "model": "m"},
    )
    assert out == "回答内容"


def test_chat_completion_raises_without_key(monkeypatch):
    monkeypatch.delenv("REFINER_API_KEY", raising=False)
    with pytest.raises(AssistantError, match="REFINER_API_KEY"):
        chat_completion([{"role": "user", "content": "hi"}], {"api_base": "https://x/v1", "model": "m"})


def test_chat_completion_raises_without_provider(monkeypatch):
    monkeypatch.setenv("REFINER_API_KEY", "sk-x")
    with pytest.raises(AssistantError, match="服务商"):
        chat_completion([{"role": "user", "content": "hi"}], {"api_base": "", "model": ""})


# ── HTTP 端点 ──


def test_assistant_status(monkeypatch):
    monkeypatch.setattr(router_module, "assistant_available", lambda cfg: True)
    with TestClient(app) as client:
        res = client.get("/api/read-podcast/assistant/status")
        assert res.status_code == 200
        assert res.json() == {"available": True}


def test_assistant_lookup(monkeypatch):
    captured = {}

    def fake_chat(messages, config, **kwargs):
        captured["messages"] = messages
        captured["kwargs"] = kwargs
        return "克罗地亚是一个欧洲国家。"

    monkeypatch.setattr(router_module, "chat_completion", fake_chat)

    with TestClient(app) as client:
        res = client.post(
            "/api/read-podcast/assistant/lookup",
            json={"term": "克罗地亚", "context": "他们在讨论旅行"},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["term"] == "克罗地亚"
        assert body["explanation"] == "克罗地亚是一个欧洲国家。"
    assert "克罗地亚" in captured["messages"][-1]["content"]
    assert "他们在讨论旅行" in captured["messages"][-1]["content"]


def test_assistant_lookup_reports_unconfigured(monkeypatch):
    def fake_chat(messages, config, **kwargs):
        raise AssistantError("未设置 REFINER_API_KEY，请在 .env 中填写后重试。")

    monkeypatch.setattr(router_module, "chat_completion", fake_chat)

    with TestClient(app) as client:
        res = client.post("/api/read-podcast/assistant/lookup", json={"term": "测试"})
        assert res.status_code == 503
        assert "REFINER_API_KEY" in res.json()["detail"]


def test_chat_with_transcript(tmp_path, monkeypatch):
    from app.models.task import Task, TaskStatus

    output = tmp_path / "note.md"
    output.write_text(
        "---\ntitle: 测试\n---\n\n## 01 | 话题\n\n**主持人**：今天我们聊播客工具。",
        encoding="utf-8",
    )
    task = Task(
        id="t1",
        podcast_name="示例",
        episode_title="第一期",
        status=TaskStatus.SUCCESS,
        output_path=str(output),
    )
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=task))

    captured = {}

    def fake_chat(messages, config, **kwargs):
        captured["messages"] = messages
        return "他们在聊播客工具。"

    monkeypatch.setattr(router_module, "chat_completion", fake_chat)

    with TestClient(app) as client:
        res = client.post(
            "/api/read-podcast/tasks/t1/chat",
            json={"question": "这期讲了什么？", "history": []},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["answer"] == "他们在聊播客工具。"
        assert body["context_truncated"] is False

    # system 提示词里应含文字稿内容（已剥离 frontmatter），但不含 frontmatter 键。
    system_prompt = captured["messages"][0]["content"]
    assert "今天我们聊播客工具" in system_prompt
    assert "title: 测试" not in system_prompt
    # 历史 + 当前问题被追加
    assert captured["messages"][-1] == {"role": "user", "content": "这期讲了什么？"}


def test_chat_with_transcript_missing_output(monkeypatch):
    from app.models.task import Task, TaskStatus

    task = Task(id="t2", podcast_name="示例", episode_title="第二期", status=TaskStatus.SUCCESS)
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=task))

    with TestClient(app) as client:
        res = client.post("/api/read-podcast/tasks/t2/chat", json={"question": "?"})
        assert res.status_code == 404


def test_chat_with_transcript_unknown_task(monkeypatch):
    monkeypatch.setattr(router_module, "get_task", AsyncMock(return_value=None))
    with TestClient(app) as client:
        res = client.post("/api/read-podcast/tasks/nope/chat", json={"question": "?"})
        assert res.status_code == 404
