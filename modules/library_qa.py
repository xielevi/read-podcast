"""跨多期播客问答的轻量检索。

不依赖向量库或外部服务：用关键词重叠（ASCII 词 + 中文二元组）为已完成的
文字稿打分，挑出与问题最相关的若干期，并从每期抽取有界的相关片段，拼成带来源
标注的上下文。生成的上下文交给 OpenAI 兼容模型综合作答（见 refiner.chat_completion）。

设计目标：确定性、可测试、零额外依赖，便于回答“最近几期讲了什么”“大家怎么评价 X”
“不同嘉宾的共识与分歧”这类跨节目问题。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

# 中文里高频但缺乏区分度的字/词，参与二元组会引入噪声，先剔除。
_CJK_STOP = set("的了是有和与也都在我你他她它们这那哪个吗呢吧啊嗯把被就还很才会要能对于把从")
# 触发“按新近排序”的措辞。
_RECENCY_HINTS = ("最近", "近期", "最新", "近几期", "这几期", "最近几期", "近来", "这段时间", "新收录")

_MAX_SCORE_TEXT = 20000  # 打分时每期最多扫描的字符数，控制耗时。
_TOKEN_COUNT_CAP = 5     # 单个词在一期内的计数上限，避免长稿刷分。


@dataclass
class EpisodeDoc:
    task_id: str
    title: str
    podcast: str
    text: str
    created_at: str = ""


@dataclass
class LibraryContext:
    context: str
    sources: list[dict] = field(default_factory=list)
    truncated: bool = False
    used_count: int = 0


def _ascii_tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]{2,}", text.lower())


def _cjk_chars(text: str) -> list[str]:
    return re.findall(r"[一-鿿]", text)


def _cjk_bigrams(chars: Iterable[str]) -> list[str]:
    chars = list(chars)
    return [chars[i] + chars[i + 1] for i in range(len(chars) - 1)]


def question_tokens(question: str) -> list[str]:
    """把问题拆成用于匹配的 token（ASCII 词 + 过滤停用字后的中文二元组）。"""
    ascii_words = _ascii_tokens(question)
    kept_chars = [c for c in _cjk_chars(question) if c not in _CJK_STOP]
    bigrams = _cjk_bigrams(kept_chars)
    seen: set[str] = set()
    tokens: list[str] = []
    for token in ascii_words + bigrams:
        if token not in seen:
            seen.add(token)
            tokens.append(token)
    return tokens


def wants_recency(question: str) -> bool:
    return any(hint in question for hint in _RECENCY_HINTS)


def score_episode(episode: EpisodeDoc, tokens: list[str]) -> int:
    if not tokens:
        return 0
    title_l = episode.title.lower()
    body_l = episode.text[:_MAX_SCORE_TEXT].lower()
    score = 0
    for token in tokens:
        if token in title_l:
            score += 5  # 命中标题给更高权重
        count = body_l.count(token)
        if count:
            score += min(count, _TOKEN_COUNT_CAP)
    return score


def _excerpt(text: str, tokens: list[str], budget: int) -> str:
    """抽取包含问题 token 的窗口；无命中时回退开头片段。"""
    if budget <= 0:
        return ""
    lowered = text.lower()
    positions: list[int] = []
    for token in tokens:
        idx = lowered.find(token)
        if idx >= 0:
            positions.append(idx)
    if not positions:
        head = text[:budget].strip()
        return head + ("…" if len(text) > budget else "")

    positions.sort()
    windows: list[tuple[int, int]] = []
    for pos in positions:
        start = max(0, pos - 120)
        end = min(len(text), pos + 280)
        if windows and start <= windows[-1][1]:
            windows[-1] = (windows[-1][0], max(windows[-1][1], end))
        else:
            windows.append((start, end))

    pieces: list[str] = []
    used = 0
    for start, end in windows:
        chunk = text[start:end].strip()
        if used + len(chunk) > budget:
            chunk = chunk[: max(0, budget - used)]
        if chunk:
            pieces.append(("…" if start > 0 else "") + chunk + ("…" if end < len(text) else ""))
            used += len(chunk)
        if used >= budget:
            break
    return " ".join(pieces)


def build_library_context(
    question: str,
    episodes: list[EpisodeDoc],
    *,
    max_episodes: int = 6,
    per_episode_chars: int = 3000,
    total_chars: int = 18000,
) -> LibraryContext:
    """挑选相关节目并拼装带来源编号的上下文。"""
    if not episodes:
        return LibraryContext(context="", sources=[], truncated=False, used_count=0)

    tokens = question_tokens(question)
    scored = [(score_episode(ep, tokens), ep) for ep in episodes]
    any_hits = any(score > 0 for score, _ in scored)
    strong_hits = any(score >= 2 for score, _ in scored)

    # 新近意图、或问题过泛（没有强命中）时，按时间倒序；否则按相关度排序。
    if (wants_recency(question) and not strong_hits) or not any_hits:
        ordered = list(episodes)  # 调用方已按 created_at DESC 传入
    else:
        ordered = [
            ep for _, ep in sorted(
                scored,
                key=lambda pair: (pair[0], _created_key(pair[1])),
                reverse=True,
            )
        ]

    selected = ordered[:max_episodes]
    truncated = len(ordered) > len(selected)

    blocks: list[str] = []
    sources: list[dict] = []
    used = 0
    for index, ep in enumerate(selected, start=1):
        remaining = total_chars - used
        if remaining <= 0:
            truncated = True
            break
        budget = min(per_episode_chars, remaining)
        excerpt = _excerpt(ep.text, tokens, budget)
        if not excerpt:
            continue
        label = f"《{ep.title}》" + (f"（{ep.podcast}）" if ep.podcast else "")
        blocks.append(f"【{index}】{label}\n{excerpt}")
        sources.append({"index": index, "task_id": ep.task_id, "title": ep.title, "podcast": ep.podcast})
        used += len(excerpt)
        if len(ep.text) > budget:
            truncated = True

    return LibraryContext(
        context="\n\n".join(blocks),
        sources=sources,
        truncated=truncated,
        used_count=len(sources),
    )


def _created_key(episode: EpisodeDoc) -> str:
    return episode.created_at or ""
