"""AI 阅读助手：百科查询、单篇文字稿问答、跨库问答、关键概念 → 维基百科。

复用 refiner 段的 OpenAI 兼容服务商配置与 REFINER_API_KEY，不引入新的凭据来源。
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Dict, List

from fastapi import APIRouter, HTTPException

from app.database import get_task, list_successful_tasks
from app.models.task import Task
from app.routers._shared import ALLOWED_TEXT_OUTPUT_EXTS, read_task_output_text
from app.schemas import ChatRequest, ConceptsRequest, LibraryChatRequest, LookupRequest
from modules.config import settings
from modules.formatter import strip_leading_frontmatter
from modules.library_qa import EpisodeDoc, build_library_context
from modules.refiner import AssistantError, assistant_available, chat_completion
from modules.wikipedia import (
    DEFAULT_FALLBACK_LANG,
    DEFAULT_LANG,
    MAX_CONCEPTS,
    MIN_CONCEPTS,
    WikipediaError,
    collect_concepts,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Read Podcast"])

# AI 助手灌入模型的文字稿上下文预算（字符）；超长稿件截断以控制延迟与成本。
ASSISTANT_CONTEXT_CHAR_BUDGET = 24000
# 每次对话最多回带的历史轮数，防止 prompt 无限膨胀。
ASSISTANT_MAX_HISTORY = 8
# 跨节目问答检索的语料上限：最多纳入多少期已完成稿件。
LIBRARY_CORPUS_LIMIT = 60
# 单期稿件读入的字符上限，避免超长稿件拖慢检索。
LIBRARY_DOC_CHAR_CAP = 40000

# 抽取一次要过一遍 AI + 若干次维基百科查询，成本不低；同一篇稿子的结果按输出文件
# 的修改时间缓存，正文没变就直接复用（前端也不必担心重复打开阅读页触发重算）。
_concepts_cache: Dict[str, Dict] = {}
_CONCEPTS_CACHE_MAX = 128


@router.get("/assistant/status")
async def assistant_status() -> Dict:
    """助手是否可用，供前端优雅降级（未配置 AI 时隐藏入口）。"""
    return {"available": assistant_available(settings.REFINER_CONFIG)}


@router.post("/assistant/lookup")
async def assistant_lookup(body: LookupRequest) -> Dict[str, str]:
    """百科查询：解释文字稿中出现的概念、人物、机构、术语或事件。"""
    term = body.term.strip()
    if not term:
        raise HTTPException(status_code=400, detail="term 不能为空")

    system = (
        "你是一位百科式讲解助手，为正在阅读播客文字稿的读者解释其中出现的概念、人物、"
        "机构、术语或事件。用简体中文，给出准确、克制、通俗的解释，控制在 120 字以内。"
        "若为多义词，结合读者提供的上下文选择最贴切的义项。不要编造不确定的事实，"
        "不确定时明确说明。直接输出解释，不要寒暄或复述问题。"
    )
    user = f"需要解释的词条：{term}"
    context = body.context.strip()
    if context:
        user += f"\n\n它出现的上下文（节选）：\n{context[:2000]}"

    try:
        explanation = await asyncio.to_thread(
            chat_completion,
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            settings.REFINER_CONFIG,
            max_tokens=400,
            temperature=0.3,
        )
    except AssistantError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {"term": term, "explanation": explanation}


@router.post("/tasks/{task_id}/chat")
async def chat_with_transcript(task_id: str, body: ChatRequest) -> Dict:
    """针对某份已完成文字稿的问答，回答严格基于文字稿内容。"""
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")

    _output_file, content = read_task_output_text(task)
    transcript = strip_leading_frontmatter(content).strip()
    if not transcript:
        raise HTTPException(status_code=422, detail="文字稿为空，无法问答")

    truncated = len(transcript) > ASSISTANT_CONTEXT_CHAR_BUDGET
    context_text = transcript[:ASSISTANT_CONTEXT_CHAR_BUDGET]
    title = task.episode_title or "本期节目"

    system = (
        f"你是这份播客文字稿的阅读助手。下面三引号内是《{title}》的文字稿"
        + ("（因过长已截断，仅含前一部分）" if truncated else "")
        + "。请仅依据文字稿内容回答读者问题，用简体中文，准确、简洁、有条理。"
        "文字稿中找不到答案时如实说明“文字稿里没有提到”，不要编造或引入外部信息。\n\n"
        f'"""\n{context_text}\n"""'
    )
    messages: List[Dict[str, str]] = [{"role": "system", "content": system}]
    for msg in body.history[-ASSISTANT_MAX_HISTORY:]:
        messages.append({"role": msg.role, "content": msg.content.strip()})
    messages.append({"role": "user", "content": body.question.strip()})

    try:
        answer = await asyncio.to_thread(
            chat_completion,
            messages,
            settings.REFINER_CONFIG,
            max_tokens=1200,
            temperature=0.4,
        )
    except AssistantError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {"task_id": task_id, "answer": answer, "context_truncated": truncated}


def _collect_library_docs(tasks: List[Task]) -> List[EpisodeDoc]:
    """读取已完成稿件文本，构建跨节目问答的语料（有界，跳过缺失/非文本文件）。"""
    docs: List[EpisodeDoc] = []
    for task in tasks:
        if not task.output_path:
            continue
        output_file = Path(task.output_path)
        if not output_file.exists() or output_file.suffix.lower() not in ALLOWED_TEXT_OUTPUT_EXTS:
            continue
        try:
            raw = output_file.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        text = strip_leading_frontmatter(raw).strip()
        if not text:
            continue
        docs.append(
            EpisodeDoc(
                task_id=task.id,
                title=task.episode_title or output_file.stem,
                podcast=task.podcast_name or "",
                text=text[:LIBRARY_DOC_CHAR_CAP],
                created_at=task.created_at.isoformat() if task.created_at else "",
            )
        )
    return docs


@router.post("/assistant/library/chat")
async def chat_with_library(body: LibraryChatRequest) -> Dict:
    """跨多期播客问答：从最近有界稿件集中检索相关节目并标注来源。"""
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question 不能为空")

    tasks = await list_successful_tasks(LIBRARY_CORPUS_LIMIT)
    docs = await asyncio.to_thread(_collect_library_docs, tasks)
    if not docs:
        raise HTTPException(status_code=404, detail="稿件库还没有已完成的稿件，先转录几期再来提问吧。")

    selection = await asyncio.to_thread(build_library_context, question, docs)
    if not selection.context:
        raise HTTPException(status_code=422, detail="没有检索到可用于回答的稿件内容")

    system = (
        "你是一位跨多期播客的知识助手。下面用【序号】分隔的是从用户稿件库中检索到的若干期"
        "节目的相关片段。请综合这些片段回答问题，用简体中文，条理清晰。"
        "涉及不同节目的观点时，注明它们各自来自哪一期（用节目标题指代），"
        "并在合适时点出不同嘉宾/节目之间的共识与分歧。"
        "只依据给定片段作答，片段中没有的内容如实说明“稿件库里没有相关内容”，不要编造或引入外部信息。\n\n"
        f"{selection.context}"
    )
    messages: List[Dict[str, str]] = [{"role": "system", "content": system}]
    for msg in body.history[-ASSISTANT_MAX_HISTORY:]:
        messages.append({"role": msg.role, "content": msg.content.strip()})
    messages.append({"role": "user", "content": question})

    try:
        answer = await asyncio.to_thread(
            chat_completion,
            messages,
            settings.REFINER_CONFIG,
            max_tokens=1500,
            temperature=0.4,
        )
    except AssistantError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {
        "answer": answer,
        "sources": selection.sources,
        "episodes_searched": len(docs),
        "context_truncated": selection.truncated,
    }


def _wikipedia_config() -> Dict:
    raw = settings.RUNTIME_CONFIG.get("wikipedia") if isinstance(settings.RUNTIME_CONFIG, dict) else None
    return raw if isinstance(raw, dict) else {}


@router.post("/tasks/{task_id}/concepts")
async def get_task_concepts(task_id: str, body: ConceptsRequest) -> Dict:
    """抽取本篇文字稿的关键概念，并给出经过核对的维基百科链接。"""
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")

    output_file, content = read_task_output_text(task)
    transcript = strip_leading_frontmatter(content).strip()
    if not transcript:
        raise HTTPException(status_code=422, detail="文字稿为空，无法抽取关键概念")

    config = _wikipedia_config()
    limit = body.limit or int(config.get("limit", MAX_CONCEPTS) or MAX_CONCEPTS)
    limit = max(MIN_CONCEPTS, min(limit, MAX_CONCEPTS))

    try:
        mtime = output_file.stat().st_mtime_ns
    except OSError:
        mtime = 0
    cache_key = f"{task_id}:{mtime}:{limit}"
    if not body.refresh:
        cached = _concepts_cache.get(cache_key)
        if cached:
            return {**cached, "cached": True}

    try:
        result = await asyncio.to_thread(
            collect_concepts,
            task.episode_title or output_file.stem,
            task.podcast_name or "",
            transcript,
            settings.REFINER_CONFIG,
            lang=str(config.get("lang", DEFAULT_LANG) or DEFAULT_LANG),
            fallback_lang=str(config.get("fallback_lang", DEFAULT_FALLBACK_LANG) or ""),
            limit=limit,
        )
    except WikipediaError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    payload = {"task_id": task_id, **result}
    if len(_concepts_cache) >= _CONCEPTS_CACHE_MAX:
        _concepts_cache.clear()
    _concepts_cache[cache_key] = payload
    return {**payload, "cached": False}
