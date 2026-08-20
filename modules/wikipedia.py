"""关键概念抽取 + 维基百科链接。

从一篇已转录的文字稿里挑出 5–10 个值得延伸阅读的关键概念（人物、机构、术语、
事件、作品），再到**真实的维基百科**里核对，只保留确实存在词条的概念，返回可点击
的链接与摘要。

两段式设计的原因：AI 擅长「从长文里挑出哪些词值得查」，但**不能信任它给出的 URL**
（模型会编造看似合理但不存在的词条地址）。所以链接一律由维基百科 API 返回的规范
标题生成，AI 只负责提名候选词。核对不通过的候选直接丢弃。

沿用 refiner 段的服务商配置与 ``REFINER_API_KEY``，不引入新的凭据来源。
"""
from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import quote

import httpx

from modules.refiner import AssistantError, chat_completion

logger = logging.getLogger(__name__)

# 只允许维基百科自己的语言站点，URL 由代码拼装，不接受外部传入的主机名。
_LANG_PATTERN = re.compile(r"^[a-z]{2,3}(-[a-z]{2,8})*$")
DEFAULT_LANG = "zh"
DEFAULT_FALLBACK_LANG = "en"

MIN_CONCEPTS = 5
MAX_CONCEPTS = 10
_CANDIDATE_MULTIPLIER = 2  # 多提名一些候选，抵消核对阶段的淘汰
_CONTEXT_CHAR_BUDGET = 12000
_TERM_MAX_CHARS = 60
_SUMMARY_MAX_CHARS = 220
_LOOKUP_WORKERS = 6

# 维基百科要求所有 API 调用带可识别的 User-Agent。
_USER_AGENT = "read-podcast/1.0 (https://github.com/xielevi/read-podcast) httpx"


class WikipediaError(RuntimeError):
    """关键概念抽取失败。"""


# ── 语言与地址 ────────────────────────────────────────────


def _normalize_lang(lang: str, default: str) -> str:
    value = str(lang or "").strip().lower()
    if not value:
        return default
    if not _LANG_PATTERN.match(value):
        raise WikipediaError(f"不支持的维基百科语言代码：{lang}")
    return value


def _api_base(lang: str) -> str:
    return f"https://{lang}.wikipedia.org"


# ── 第一步：AI 提名候选概念 ───────────────────────────────


_SYSTEM_PROMPT = (
    "你是知识编辑，负责从播客文字稿里挑出值得读者延伸阅读的关键概念。"
    "只挑**维基百科上确实可能有独立词条**的专有名词：人物、机构、公司、技术术语、"
    "理论、事件、作品、地点。不要挑常识词、口语词、泛指词（如「人工智能的发展」「这家公司」），"
    "也不要挑文字稿里没出现过的东西。"
    "按对理解这期节目的重要性排序，最重要的在前。"
    '只输出 JSON 数组，每项形如 {"term": "词条名", "reason": "12 字以内说明为何值得查"}，'
    "不要输出数组以外的任何文字、解释或代码块标记。"
)


def _strip_code_fence(text: str) -> str:
    """模型常把 JSON 包在 ```json 围栏里，这里剥掉。"""
    s = text.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    return s.strip()


def _parse_candidates(raw: str) -> list[dict[str, str]]:
    """解析模型返回的 JSON 数组；容忍前后夹带的散文。"""
    text = _strip_code_fence(raw)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if not match:
            raise WikipediaError("AI 未返回可解析的概念列表。")
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise WikipediaError("AI 返回的概念列表不是合法 JSON。") from exc

    if not isinstance(data, list):
        raise WikipediaError("AI 返回的概念列表格式不正确。")

    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in data:
        if isinstance(item, str):
            term, reason = item, ""
        elif isinstance(item, dict):
            term = str(item.get("term") or item.get("name") or "").strip()
            reason = str(item.get("reason") or "").strip()
        else:
            continue
        term = term.strip()[:_TERM_MAX_CHARS]
        key = term.casefold()
        if not term or key in seen:
            continue
        seen.add(key)
        out.append({"term": term, "reason": reason})
    return out


def propose_concepts(
    title: str,
    podcast: str,
    transcript: str,
    refiner_config: dict,
    *,
    limit: int = MAX_CONCEPTS,
) -> list[dict[str, str]]:
    """让 AI 从文字稿里提名候选概念（尚未核对维基百科）。"""
    body = str(transcript or "").strip()
    if not body:
        raise WikipediaError("文字稿为空，无法抽取关键概念。")

    context = body[:_CONTEXT_CHAR_BUDGET]
    truncated_note = "（文字稿较长，仅据前一部分抽取）\n\n" if len(body) > _CONTEXT_CHAR_BUDGET else ""
    header = f"《{title}》" + (f"（{podcast}）" if podcast else "")
    want = max(1, min(int(limit), MAX_CONCEPTS)) * _CANDIDATE_MULTIPLIER
    user = (
        f"{truncated_note}节目：{header}\n\n"
        f"请挑出 {want} 个关键概念。\n\n"
        f'文字稿：\n"""\n{context}\n"""'
    )

    try:
        raw = chat_completion(
            [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user},
            ],
            refiner_config,
            max_tokens=900,
            temperature=0.2,
        )
    except AssistantError as exc:
        raise WikipediaError(str(exc)) from exc

    candidates = _parse_candidates(raw)
    if not candidates:
        raise WikipediaError("AI 未能从这篇文字稿里挑出关键概念。")
    return candidates


# ── 第二步：到维基百科核对 ────────────────────────────────


def _get_json(client: httpx.Client, url: str, *, params: dict | None = None) -> dict | None:
    try:
        response = client.get(url, params=params)
    except httpx.HTTPError:
        return None
    if response.status_code >= 300:
        return None
    try:
        data = response.json()
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _search_title(client: httpx.Client, lang: str, term: str) -> str:
    """用搜索接口拿到规范词条标题；找不到返回空串。"""
    data = _get_json(
        client,
        f"{_api_base(lang)}/w/api.php",
        params={
            "action": "query",
            "format": "json",
            "list": "search",
            "srsearch": term,
            "srlimit": 3,
            "srnamespace": 0,
        },
    )
    if not data:
        return ""
    results = ((data.get("query") or {}).get("search")) or []
    for item in results:
        if not isinstance(item, dict):
            continue
        candidate = str(item.get("title") or "").strip()
        # 全文搜索对任何词都会返回结果，哪怕毫不相干（「阿尔法折叠」会命中「CASP」）。
        # 错误的链接比没有链接更糟，所以只接受与原词足够接近的标题。
        if candidate and _titles_related(term, candidate):
            return candidate
    return ""


def _normalize_title(text: str) -> str:
    """比较标题用：去掉空白、连接符与消歧义括号后小写。"""
    s = re.sub(r"[（(][^）)]*[）)]\s*$", "", str(text or "").strip())
    s = re.sub(r"[\s_·・\-–—]", "", s)
    return s.casefold()


def _titles_related(term: str, candidate: str) -> bool:
    """判断搜索结果是否确实对应原词，而不是一个沾边的页面。"""
    a, b = _normalize_title(term), _normalize_title(candidate)
    if not a or not b:
        return False
    # 互为前缀/子串即可（「量子计算」↔「量子计算机」），但短词要求更严，
    # 避免「AI」匹配上任何含 ai 的标题。
    if a == b:
        return True
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    if len(shorter) < 2:
        return False
    # 0.6 而不是 0.5：短的拉丁缩写在 0.5 下会误配（「AI」↔「AIDS」正好 2/4），
    # 而真正的扩展式标题（「量子计算」↔「量子计算机」= 4/5）仍能通过。
    if shorter in longer:
        return len(shorter) / len(longer) >= 0.6
    return False


def _page_summary(client: httpx.Client, lang: str, page_title: str) -> dict[str, Any] | None:
    """取词条摘要与规范地址；消歧义页视为无效。"""
    data = _get_json(
        client,
        f"{_api_base(lang)}/api/rest_v1/page/summary/{quote(page_title.replace(' ', '_'), safe='')}",
        params={"redirect": "true"},
    )
    if not data or data.get("type") == "disambiguation":
        return None

    resolved = str(data.get("title") or "").strip()
    url = str((((data.get("content_urls") or {}).get("desktop")) or {}).get("page") or "").strip()
    if not resolved or not url:
        return None

    extract = " ".join(str(data.get("extract") or "").split())
    if len(extract) > _SUMMARY_MAX_CHARS:
        extract = extract[:_SUMMARY_MAX_CHARS].rstrip() + "…"
    return {"title": resolved, "url": url, "summary": extract}


def lookup_concept(
    client: httpx.Client,
    term: str,
    *,
    lang: str,
    fallback_lang: str = "",
) -> dict[str, Any] | None:
    """核对单个概念：主语言找不到就退到备用语言；都没有则返回 None。"""
    for candidate_lang in [lang, fallback_lang]:
        if not candidate_lang:
            continue
        # 先按词条名直接查：命中率最高，且维基百科会自动跟随重定向
        # （「斯坦福大学」→「史丹佛大學」），不经过全文搜索的相关性噪音。
        summary = _page_summary(client, candidate_lang, term)
        if summary:
            return {**summary, "lang": candidate_lang}
        # 直查不中再退到搜索，结果需通过 _titles_related 校验。
        page_title = _search_title(client, candidate_lang, term)
        if not page_title:
            continue
        summary = _page_summary(client, candidate_lang, page_title)
        if summary:
            return {**summary, "lang": candidate_lang}
    return None


# ── 对外入口 ──────────────────────────────────────────────


def collect_concepts(
    title: str,
    podcast: str,
    transcript: str,
    refiner_config: dict,
    *,
    lang: str = DEFAULT_LANG,
    fallback_lang: str = DEFAULT_FALLBACK_LANG,
    limit: int = MAX_CONCEPTS,
    timeout: int = 10,
) -> dict[str, Any]:
    """抽取关键概念并逐个核对维基百科，返回已确认存在词条的概念。

    返回 ``{"concepts": [...], "proposed": n, "lang": ...}``；每个概念含
    ``term`` / ``reason`` / ``wikipedia_title`` / ``url`` / ``summary`` / ``lang``。
    """
    primary = _normalize_lang(lang, DEFAULT_LANG)
    secondary = _normalize_lang(fallback_lang, "") if fallback_lang else ""
    if secondary == primary:
        secondary = ""
    want = max(1, min(int(limit), MAX_CONCEPTS))

    candidates = propose_concepts(title, podcast, transcript, refiner_config, limit=want)

    headers = {"User-Agent": _USER_AGENT, "Accept": "application/json"}
    concepts: list[dict[str, Any]] = []
    with httpx.Client(timeout=timeout, headers=headers, follow_redirects=True) as client:
        def _resolve(candidate: dict[str, str]) -> dict[str, Any] | None:
            found = lookup_concept(client, candidate["term"], lang=primary, fallback_lang=secondary)
            if not found:
                return None
            return {
                "term": candidate["term"],
                "reason": candidate.get("reason", ""),
                "wikipedia_title": found["title"],
                "url": found["url"],
                "summary": found["summary"],
                "lang": found["lang"],
            }

        with ThreadPoolExecutor(max_workers=_LOOKUP_WORKERS) as pool:
            # 保留 AI 给出的重要性顺序：按候选顺序收集结果，而不是按完成顺序。
            for resolved in pool.map(_resolve, candidates):
                if resolved:
                    concepts.append(resolved)

    # 同一词条可能被多个候选命中（如「OpenAI」和「Open AI」），按规范标题去重。
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for concept in concepts:
        key = f"{concept['lang']}:{concept['wikipedia_title']}".casefold()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(concept)

    logger.info(
        "关键概念抽取：提名 %d 个，命中维基百科 %d 个（%s）",
        len(candidates),
        len(deduped),
        primary,
    )
    return {
        "concepts": deduped[:want],
        "proposed": len(candidates),
        "lang": primary,
        "fallback_lang": secondary,
    }
