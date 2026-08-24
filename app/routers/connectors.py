"""文件连接器（把成稿推送到外部文档/群机器人）与 OAuth 账号集成。"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Dict, List

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse

from app.database import get_task
from app.routers._shared import read_task_output_text
from app.routers.assistant import ASSISTANT_CONTEXT_CHAR_BUDGET
from app.schemas import ExportRequest, OAuthAppCredentialsRequest, OAuthAuthorizeRequest
from modules.config import settings
from modules.connectors import (
    ConnectorError,
    available_connectors,
    find_connector,
    send_document,
)
from modules.connectors import test_connector as precheck_connector
from modules.formatter import strip_leading_frontmatter
from modules.oauth_integrations import (
    OAuthIntegrationError,
    begin_authorization,
    cancel_authorization,
    complete_authorization,
    effective_connectors,
    integration_statuses,
    save_app_credentials,
)
from modules.refiner import AssistantError, chat_completion
from modules.utils import extract_frontmatter

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Read Podcast"])


def _connectors() -> List[Dict]:
    return effective_connectors(settings.CONNECTORS)


def _request_origin(request: Request) -> str:
    return f"{request.url.scheme}://{request.url.netloc}"


def _oauth_callback_html(provider: str, ok: bool, detail: str, origin: str) -> HTMLResponse:
    payload = json.dumps(
        {"type": "read-podcast-oauth", "provider": provider, "ok": ok, "detail": detail},
        ensure_ascii=False,
    ).replace("<", "\\u003c").replace(">", "\\u003e")
    target_origin = json.dumps(origin).replace("<", "\\u003c").replace(">", "\\u003e")
    title = "账号已连接" if ok else "账号连接失败"
    body = (
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
        f"<title>{title}</title></head><body><p>{title}</p><script>"
        f"if(window.opener){{window.opener.postMessage({payload},{target_origin});}}"
        "window.close();</script></body></html>"
    )
    return HTMLResponse(body, headers={"Cache-Control": "no-store"})


@router.get("/integrations")
async def get_integrations() -> List[Dict]:
    """返回 OAuth 应用与账号连接状态，不含任何凭据或令牌。"""
    return integration_statuses()


@router.put("/integrations/{provider}/app")
async def put_integration_app(provider: str, body: OAuthAppCredentialsRequest) -> Dict:
    """保存开发者应用凭据；机密只落本机 secrets.env。"""
    try:
        return await asyncio.to_thread(
            save_app_credentials,
            provider,
            body.client_id,
            body.client_secret,
        )
    except OAuthIntegrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/integrations/{provider}/authorize")
async def authorize_integration(
    provider: str,
    body: OAuthAuthorizeRequest,
    request: Request,
) -> Dict:
    """创建一次性 state 并返回第三方授权地址。"""
    try:
        return begin_authorization(provider, body.redirect_uri, _request_origin(request))
    except OAuthIntegrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/integrations/{provider}/callback")
async def integration_callback(
    provider: str,
    request: Request,
    state: str = "",
    code: str = "",
    error: str = "",
) -> HTMLResponse:
    """校验 state、交换令牌并通知同源登录窗口。"""
    origin = _request_origin(request)
    try:
        if error:
            pending = cancel_authorization(provider, state)
            origin = pending["origin"]
            raise OAuthIntegrationError("用户取消了授权")
        result = await asyncio.to_thread(complete_authorization, provider, code, state)
        origin = str(result.pop("origin"))
        return _oauth_callback_html(provider, True, "账号已连接", origin)
    except OAuthIntegrationError as exc:
        return _oauth_callback_html(provider, False, str(exc), origin)


@router.get("/connectors")
async def get_connectors() -> List[Dict]:
    """可用连接器清单（不含 Webhook 地址），供前端渲染导出入口。"""
    return available_connectors(_connectors())


@router.post("/tasks/{task_id}/export")
async def export_task(task_id: str, body: ExportRequest) -> Dict:
    """把某份成稿推送到指定连接器目标。"""
    task = await get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务 {task_id} 不存在")

    connector = find_connector(_connectors(), body.connector.strip())
    if not connector:
        raise HTTPException(status_code=404, detail=f"连接器 '{body.connector}' 不存在")

    _output_file, content = read_task_output_text(task)
    parsed_frontmatter = extract_frontmatter(content.lstrip())[0]
    frontmatter = parsed_frontmatter if isinstance(parsed_frontmatter, dict) else {}
    source_link = str(frontmatter.get("source_link") or frontmatter.get("link") or "")
    title = task.episode_title or _output_file.stem
    transcript = strip_leading_frontmatter(content).strip()

    if body.mode == "summary":
        markdown = await _build_knowledge_entry(title, task.podcast_name or "", transcript)
    else:
        markdown = transcript

    doc = {
        "title": title,
        "podcast": task.podcast_name or "",
        "markdown": markdown,
        "source_link": source_link,
    }

    try:
        result = await asyncio.to_thread(send_document, connector, doc)
    except ConnectorError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {"task_id": task_id, "status": "sent", "mode": body.mode, **result}


async def _build_knowledge_entry(title: str, podcast: str, transcript: str) -> str:
    """用 AI 从文字稿提炼可沉淀的知识条目（核心观点/案例/知识点/选题）。"""
    if not transcript:
        raise HTTPException(status_code=422, detail="文字稿为空，无法生成知识条目")
    context = transcript[:ASSISTANT_CONTEXT_CHAR_BUDGET]
    truncated_note = "（文字稿较长，仅据前一部分提炼）\n\n" if len(transcript) > ASSISTANT_CONTEXT_CHAR_BUDGET else ""
    system = (
        "你是知识管理助手，负责把播客文字稿沉淀成可长期复用的知识条目。"
        "只依据给定文字稿，用简体中文输出结构化 Markdown，包含这些小节："
        "## 核心观点、## 关键案例、## 可沉淀的知识点、## 可延伸选题。"
        "每条简明扼要、忠于原文，文字稿没有提到的不要编造；无对应内容的小节可写“（本期未涉及）”。"
        "不要输出正文之外的说明。"
    )
    header = f"《{title}》" + (f"（{podcast}）" if podcast else "")
    user = f"{truncated_note}节目：{header}\n\n文字稿：\n\"\"\"\n{context}\n\"\"\""
    try:
        entry = await asyncio.to_thread(
            chat_completion,
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            settings.REFINER_CONFIG,
            max_tokens=1600,
            temperature=0.3,
        )
    except AssistantError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return f"# {header} · 知识条目\n\n{entry}"


@router.post("/connectors/{name}/test")
async def test_connector_endpoint(name: str) -> Dict:
    """预检连接器凭据/可达性，不产生正式内容。"""
    connector = find_connector(_connectors(), name.strip())
    if not connector:
        raise HTTPException(status_code=404, detail=f"连接器 '{name}' 不存在")
    try:
        return await asyncio.to_thread(precheck_connector, connector)
    except ConnectorError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
