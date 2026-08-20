"""跨多期播客问答：检索模块与端点测试。"""
import sys
from pathlib import Path
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from app.standalone import app
from app import router as router_module
from modules.library_qa import (
    EpisodeDoc,
    build_library_context,
    question_tokens,
    score_episode,
    wants_recency,
)


# ── 检索模块 ──


def test_question_tokens_mixes_ascii_and_cjk_bigrams():
    tokens = question_tokens("他们如何评价 AI Agent？")
    assert "ai" in tokens
    assert "agent" in tokens
    assert "评价" in tokens
    # 停用字 “的/了” 不应单独成词干扰匹配
    assert "的" not in tokens


def test_wants_recency():
    assert wants_recency("最近10期主要讲了什么")
    assert not wants_recency("他们怎么看迪士尼的飞轮")


def test_score_episode_prefers_keyword_matches():
    ep_hit = EpisodeDoc("t1", "AI Agent 专题", "十字路口", "我们聊聊 AI Agent 的落地与评价。")
    ep_miss = EpisodeDoc("t2", "迪士尼的故事", "Acquired", "今天讲迪士尼的商业飞轮。")
    tokens = question_tokens("他们如何评价 AI Agent")
    assert score_episode(ep_hit, tokens) > score_episode(ep_miss, tokens)


def test_build_library_context_selects_relevant_and_attributes_sources():
    episodes = [
        EpisodeDoc("t1", "AI Agent 元年", "十字路口", "AI Agent 正在重写软件交互层，" + "内容" * 200, "2026-08-01"),
        EpisodeDoc("t2", "迪士尼飞轮", "Acquired", "迪士尼靠角色和故事构建商业飞轮。" + "内容" * 200, "2026-07-01"),
        EpisodeDoc("t3", "企业级 Agent", "a16z", "企业 Agent 已经进入客服与销售工作流。" + "内容" * 200, "2026-06-01"),
    ]
    result = build_library_context("大家如何评价 AI Agent？", episodes, max_episodes=2)

    assert result.used_count >= 1
    # 命中 Agent 的两期应被选中，迪士尼那期不应排在前面
    titles = [s["title"] for s in result.sources]
    assert "AI Agent 元年" in titles or "企业级 Agent" in titles
    # 来源编号与上下文中的【n】标注一致
    assert result.sources[0]["index"] == 1
    assert "【1】" in result.context
    assert result.truncated is True  # 3 期里只选了 2 期


def test_build_library_context_generic_question_orders_by_recency():
    episodes = [
        EpisodeDoc("t1", "新一期", "P", "泛泛内容一。", "2026-08-01"),
        EpisodeDoc("t2", "旧一期", "P", "泛泛内容二。", "2026-01-01"),
    ]
    # 问题与任何 token 都不强命中 → 走新近排序（调用方已按时间倒序传入）
    result = build_library_context("最近都聊了些什么", episodes, max_episodes=1)
    assert result.sources[0]["title"] == "新一期"


def test_build_library_context_empty():
    result = build_library_context("任何问题", [])
    assert result.context == ""
    assert result.sources == []
    assert result.used_count == 0


# ── 端点 ──


def _make_task(tmp_path, task_id, title, podcast, body):
    from app.models.task import Task, TaskStatus

    output = tmp_path / f"{task_id}.md"
    output.write_text(f"---\ntitle: {title}\n---\n\n{body}", encoding="utf-8")
    return Task(
        id=task_id,
        podcast_name=podcast,
        episode_title=title,
        status=TaskStatus.SUCCESS,
        output_path=str(output),
    )


def test_library_chat_no_completed(monkeypatch):
    monkeypatch.setattr(router_module, "list_successful_tasks", AsyncMock(return_value=[]))
    with TestClient(app) as client:
        res = client.post("/api/read-podcast/assistant/library/chat", json={"question": "讲了啥"})
        assert res.status_code == 404


def test_library_chat_answers_with_sources(tmp_path, monkeypatch):
    tasks = [
        _make_task(tmp_path, "t1", "AI Agent 元年", "十字路口", "AI Agent 正在重写软件交互层。" + "细节" * 100),
        _make_task(tmp_path, "t2", "企业级 Agent", "a16z", "企业 Agent 进入客服与销售。" + "细节" * 100),
        _make_task(tmp_path, "t3", "迪士尼飞轮", "Acquired", "迪士尼的商业飞轮。" + "细节" * 100),
    ]
    monkeypatch.setattr(router_module, "list_successful_tasks", AsyncMock(return_value=tasks))

    captured = {}

    def fake_chat(messages, config, **kwargs):
        captured["system"] = messages[0]["content"]
        captured["user"] = messages[-1]["content"]
        return "综合来看，多期节目都认为 Agent 已进入真实业务。"

    monkeypatch.setattr(router_module, "chat_completion", fake_chat)

    with TestClient(app) as client:
        res = client.post(
            "/api/read-podcast/assistant/library/chat",
            json={"question": "他们如何评价 AI Agent？"},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["answer"].startswith("综合来看")
        assert body["episodes_searched"] == 3
        assert len(body["sources"]) >= 1
        # 命中 Agent 的节目应进入来源，迪士尼不应是首选
        titles = [s["title"] for s in body["sources"]]
        assert any("Agent" in t for t in titles)

    # system 提示词里应含检索到的片段与来源编号
    assert "【1】" in captured["system"]
    assert captured["user"] == "他们如何评价 AI Agent？"


def test_library_chat_unconfigured(tmp_path, monkeypatch):
    tasks = [_make_task(tmp_path, "t1", "某期", "P", "一些内容。" + "字" * 100)]
    monkeypatch.setattr(router_module, "list_successful_tasks", AsyncMock(return_value=tasks))

    def fake_chat(messages, config, **kwargs):
        from modules.refiner import AssistantError

        raise AssistantError("未设置 REFINER_API_KEY，请在 .env 中填写后重试。")

    monkeypatch.setattr(router_module, "chat_completion", fake_chat)

    with TestClient(app) as client:
        res = client.post("/api/read-podcast/assistant/library/chat", json={"question": "讲了啥"})
        assert res.status_code == 503
