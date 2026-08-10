"""文件连接器：把成稿推送到外部文档/群机器人（Webhook）。

设计与项目一致：**代码不硬编码任何提供商**。连接器在配置里声明 `name`、`format`
与承载 Webhook 地址的环境变量名 `url_env`；真实地址（通常含 token，属机密）只从
环境变量读取。发送前用 `validate_public_url` 做 SSRF 校验，正文按格式与长度上限裁剪。

内置 format：
- ``feishu``   飞书自定义机器人（text 消息）
- ``dingtalk`` 钉钉自定义机器人（markdown 消息）
- ``slack``    Slack / 兼容 Incoming Webhook（text 消息）
- ``markdown`` 通用 Webhook：POST 结构化 JSON（title/podcast/markdown/source_link）
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from modules.network_security import UnsafeUrlError, validate_public_url

logger = logging.getLogger(__name__)

SUPPORTED_FORMATS = {"feishu", "dingtalk", "slack", "markdown"}
# 群机器人类平台的消息体较小，正文按此上限裁剪；通用 Webhook 放宽。
_DEFAULT_MAX_CHARS = {"feishu": 20000, "dingtalk": 18000, "slack": 20000, "markdown": 40000}


class ConnectorError(RuntimeError):
    """连接器发送失败。"""


def _connector_max_chars(connector: dict) -> int:
    fmt = str(connector.get("format", "markdown"))
    default = _DEFAULT_MAX_CHARS.get(fmt, 20000)
    try:
        override = int(connector.get("max_chars", 0))
    except (TypeError, ValueError):
        override = 0
    return override if override > 0 else default


def available_connectors(config: list | None) -> list[dict]:
    """返回连接器清单（不含 Webhook 地址），标注是否已配置好凭据。"""
    result: list[dict] = []
    for connector in config or []:
        if not isinstance(connector, dict):
            continue
        name = str(connector.get("name", "")).strip()
        fmt = str(connector.get("format", "markdown")).strip() or "markdown"
        if not name or fmt not in SUPPORTED_FORMATS:
            continue
        url_env = str(connector.get("url_env", "")).strip()
        result.append(
            {
                "name": name,
                "format": fmt,
                "configured": bool(url_env and os.environ.get(url_env, "").strip()),
            }
        )
    return result


def find_connector(config: list | None, name: str) -> dict | None:
    for connector in config or []:
        if isinstance(connector, dict) and str(connector.get("name", "")).strip() == name:
            return connector
    return None


def build_payload(fmt: str, doc: dict, max_chars: int) -> tuple[dict[str, Any], bool]:
    """按格式构造请求体，返回 (json_body, truncated)。"""
    title = str(doc.get("title", "")).strip() or "未命名稿件"
    podcast = str(doc.get("podcast", "")).strip()
    source_link = str(doc.get("source_link", "")).strip()
    body = str(doc.get("markdown", "")).strip()

    truncated = len(body) > max_chars
    body = body[:max_chars]
    if truncated:
        body += "\n\n…（内容较长，已截断）"

    if fmt == "feishu":
        header = title + (f"（{podcast}）" if podcast else "")
        text = header + "\n\n" + body
        if source_link:
            text += f"\n\n原节目：{source_link}"
        return {"msg_type": "text", "content": {"text": text}}, truncated

    if fmt == "dingtalk":
        md = f"# {title}\n\n"
        if podcast:
            md += f"> {podcast}\n\n"
        md += body
        if source_link:
            md += f"\n\n[原节目]({source_link})"
        return {"msgtype": "markdown", "markdown": {"title": title, "text": md}}, truncated

    if fmt == "slack":
        header = f"*{title}*" + (f" ({podcast})" if podcast else "")
        text = header + "\n\n" + body
        if source_link:
            text += f"\n\n<{source_link}|原节目>"
        return {"text": text}, truncated

    # markdown（通用 Webhook）
    return (
        {
            "title": title,
            "podcast": podcast,
            "source_link": source_link,
            "markdown": body,
            "truncated": truncated,
        },
        truncated,
    )


def _response_ok(fmt: str, response: httpx.Response) -> tuple[bool, str]:
    """判断平台级成功；飞书/钉钉在 HTTP 200 下仍可能返回业务错误码。"""
    if response.status_code < 200 or response.status_code >= 300:
        return False, f"HTTP {response.status_code}"
    try:
        data = response.json()
    except Exception:
        return True, ""
    if not isinstance(data, dict):
        return True, ""
    # 飞书: code==0 成功；钉钉: errcode==0 成功。
    for key in ("code", "errcode"):
        if key in data and data.get(key) not in (0, None):
            message = str(data.get("msg") or data.get("errmsg") or f"{key}={data.get(key)}")
            return False, message
    return True, ""


def send_document(
    connector: dict,
    doc: dict,
    *,
    timeout: int = 20,
) -> dict:
    """把成稿发送到连接器目标。失败抛 :class:`ConnectorError`。"""
    name = str(connector.get("name", "")).strip()
    fmt = str(connector.get("format", "markdown")).strip() or "markdown"
    if fmt not in SUPPORTED_FORMATS:
        raise ConnectorError(f"不支持的连接器格式：{fmt}")

    url_env = str(connector.get("url_env", "")).strip()
    if not url_env:
        raise ConnectorError(f"连接器「{name}」未配置 url_env。")
    url = os.environ.get(url_env, "").strip()
    if not url:
        raise ConnectorError(f"连接器「{name}」的 Webhook 地址未设置（环境变量 {url_env} 为空）。")

    try:
        validate_public_url(url)
    except UnsafeUrlError as exc:
        raise ConnectorError(f"连接器「{name}」的 Webhook 地址不安全：{exc}") from exc

    payload, truncated = build_payload(fmt, doc, _connector_max_chars(connector))

    try:
        response = httpx.post(url, json=payload, timeout=timeout)
    except httpx.TimeoutException as exc:
        raise ConnectorError(f"连接器「{name}」发送超时。") from exc
    except httpx.HTTPError as exc:
        raise ConnectorError(f"连接器「{name}」发送失败：网络错误。") from exc

    ok, detail = _response_ok(fmt, response)
    if not ok:
        # 不记录响应正文与地址，避免泄露 token。
        logger.warning("连接器发送失败 [%s/%s]: %s", name, fmt, detail)
        raise ConnectorError(f"目标返回失败：{detail}")

    return {"connector": name, "format": fmt, "truncated": truncated, "ok": True}
