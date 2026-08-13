"""文件连接器：把成稿推送到外部群机器人（Webhook）或云文档（知识库）。

设计与项目一致：**代码不硬编码任何提供商**。连接器在配置里声明 `name`、`format`
与承载凭据的**环境变量名**；真实凭据（Webhook 地址 / token / app secret，均属机密）
只从环境变量读取。发送前对目标地址做 SSRF 校验（`validate_public_url`）。

两类目标：

- **Webhook 群机器人**（短消息）：`feishu` / `dingtalk` / `slack` / `markdown`。
  连接器声明 `url_env`（Webhook 地址所在环境变量）。
- **云文档知识库**（真正的文档）：
  - `notion`   在某个 Notion 数据库或页面下新建页面。声明 `token_env` +
    `database_id`（配 `title_property`，默认 `Name`）或 `page_id`。
  - `feishu-doc` 在飞书/Lark 新建一篇 Docx 文档。声明 `app_id_env`、`app_secret_env`，
    可选 `folder_token`、`base_url`（默认 `https://open.feishu.cn`，Lark 用
    `https://open.larksuite.com`）。
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from modules.network_security import UnsafeUrlError, validate_public_url

logger = logging.getLogger(__name__)

WEBHOOK_FORMATS = {"feishu", "dingtalk", "slack", "markdown"}
DOC_FORMATS = {"notion", "feishu-doc"}
SUPPORTED_FORMATS = WEBHOOK_FORMATS | DOC_FORMATS

# 群机器人类消息体较小，正文按此上限裁剪；通用 Webhook 与云文档放宽。
_DEFAULT_MAX_CHARS = {
    "feishu": 20000,
    "dingtalk": 18000,
    "slack": 20000,
    "markdown": 40000,
    "notion": 40000,
    "feishu-doc": 40000,
}
# 云文档按块写入的上限，避免超长文档一次请求过大。
_MAX_DOC_BLOCKS = 90
_MAX_BLOCK_CHARS = 1800

NOTION_BASE = "https://api.notion.com"
NOTION_VERSION = "2022-06-28"
_NOTION_RICH_TEXT_MAX = 2000  # Notion 单个 rich_text 内容长度上限
FEISHU_DEFAULT_BASE = "https://open.feishu.cn"


class ConnectorError(RuntimeError):
    """连接器发送失败。"""


# ── 配置与可用性 ──────────────────────────────────────────


def _cfg(connector: dict, key: str, default: str = "") -> str:
    """读取连接器配置里的字符串字段（去空白；空值回落到 default）。"""
    return str(connector.get(key) or default).strip()


def _env_value(name: str) -> str:
    return os.environ.get(name, "").strip()


def _connector_kind(fmt: str) -> str:
    return "doc" if fmt in DOC_FORMATS else "webhook"


def _required_env(connector: dict) -> list[str] | None:
    """返回该连接器必须配好的环境变量名；配置本身残缺时返回 None。"""
    fmt = _cfg(connector, "format")
    if fmt in WEBHOOK_FORMATS:
        keys = ["url_env"]
    elif fmt == "notion":
        keys = ["token_env"]
    elif fmt == "feishu-doc":
        keys = ["app_id_env", "app_secret_env"]
    else:
        return None
    names = [_cfg(connector, key) for key in keys]
    return names if all(names) else None


def _connector_configured(connector: dict) -> bool:
    names = _required_env(connector)
    if names is None or not all(_env_value(name) for name in names):
        return False
    # 云文档还需要指向具体目标
    if _cfg(connector, "format") == "notion":
        return bool(_cfg(connector, "database_id") or _cfg(connector, "page_id"))
    return True


def _connector_max_chars(connector: dict) -> int:
    default = _DEFAULT_MAX_CHARS.get(_cfg(connector, "format"), 20000)
    try:
        override = int(connector.get("max_chars", 0) or 0)
    except (TypeError, ValueError) as exc:
        name = _cfg(connector, "name") or "未命名"
        raise ConnectorError(f"连接器「{name}」的 max_chars 必须是整数。") from exc
    return override if override > 0 else default


def available_connectors(config: list | None) -> list[dict]:
    """返回连接器清单（不含任何地址/凭据），标注类型与是否已配置好。"""
    result: list[dict] = []
    for connector in config or []:
        if not isinstance(connector, dict):
            continue
        name = _cfg(connector, "name")
        fmt = _cfg(connector, "format", "markdown")
        if not name or fmt not in SUPPORTED_FORMATS:
            continue
        result.append(
            {
                "name": name,
                "format": fmt,
                "kind": _connector_kind(fmt),
                "configured": _connector_configured(connector),
            }
        )
    return result


def find_connector(config: list | None, name: str) -> dict | None:
    for connector in config or []:
        if isinstance(connector, dict) and str(connector.get("name", "")).strip() == name:
            return connector
    return None


# ── 正文裁剪与结构化 ──────────────────────────────────────


def _clip_body(doc: dict, max_chars: int) -> tuple[str, bool]:
    body = str(doc.get("markdown", "")).strip()
    truncated = len(body) > max_chars
    body = body[:max_chars]
    if truncated:
        body += "\n\n…（内容较长，已截断）"
    return body, truncated


def _classify_line(line: str) -> tuple[str, str]:
    s = line.strip()
    if s.startswith("### "):
        return "h3", s[4:]
    if s.startswith("## "):
        return "h2", s[3:]
    if s.startswith("# "):
        return "h1", s[2:]
    if s.startswith(("- ", "* ", "• ")):
        return "li", s[2:]
    return "p", s


def _structured_lines(body: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for raw in body.split("\n"):
        if not raw.strip():
            continue
        kind, text = _classify_line(raw)
        if text.strip():
            out.append((kind, text[:_MAX_BLOCK_CHARS]))
        if len(out) >= _MAX_DOC_BLOCKS:
            break
    return out


# ── Webhook 群机器人 ──────────────────────────────────────


def build_payload(fmt: str, doc: dict, max_chars: int) -> tuple[dict[str, Any], bool]:
    """按 Webhook 格式构造请求体，返回 (json_body, truncated)。"""
    title = str(doc.get("title", "")).strip() or "未命名稿件"
    podcast = str(doc.get("podcast", "")).strip()
    source_link = str(doc.get("source_link", "")).strip()
    body, truncated = _clip_body(doc, max_chars)

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


def _response_ok(response: httpx.Response) -> tuple[bool, str]:
    """判断平台级成功；飞书/钉钉在 HTTP 200 下仍可能返回业务错误码。"""
    if response.status_code < 200 or response.status_code >= 300:
        return False, f"HTTP {response.status_code}"
    try:
        data = response.json()
    except Exception:
        return True, ""
    if not isinstance(data, dict):
        return True, ""
    for key in ("code", "errcode"):
        if key in data and data.get(key) not in (0, None):
            message = str(data.get("msg") or data.get("errmsg") or f"{key}={data.get(key)}")
            return False, message
    return True, ""


def _post_json(url: str, *, json_body: dict, headers: dict | None, timeout: int, label: str) -> httpx.Response:
    try:
        validate_public_url(url)
    except UnsafeUrlError as exc:
        raise ConnectorError(f"{label} 目标地址不安全：{exc}") from exc
    try:
        return httpx.post(url, json=json_body, headers=headers, timeout=timeout)
    except httpx.TimeoutException as exc:
        raise ConnectorError(f"{label} 请求超时。") from exc
    except httpx.HTTPError as exc:
        raise ConnectorError(f"{label} 网络错误。") from exc


def _send_webhook(connector: dict, doc: dict, *, timeout: int) -> dict:
    name = _cfg(connector, "name")
    fmt = _cfg(connector, "format", "markdown")
    url_env = _cfg(connector, "url_env")
    if not url_env:
        raise ConnectorError(f"连接器「{name}」未配置 url_env。")
    url = _env_value(url_env)
    if not url:
        raise ConnectorError(f"连接器「{name}」的 Webhook 地址未设置（环境变量为空）。")

    payload, truncated = build_payload(fmt, doc, _connector_max_chars(connector))
    response = _post_json(url, json_body=payload, headers=None, timeout=timeout, label=f"连接器「{name}」")
    ok, detail = _response_ok(response)
    if not ok:
        logger.warning("连接器发送失败 [%s/%s]: %s", name, fmt, detail)
        raise ConnectorError(f"目标返回失败：{detail}")
    return {"connector": name, "format": fmt, "kind": "webhook", "truncated": truncated, "ok": True}


# ── Notion 云文档 ─────────────────────────────────────────


def _notion_rich_text(content: str) -> list[dict]:
    return [{"type": "text", "text": {"content": content[:_NOTION_RICH_TEXT_MAX]}}]


def _notion_children(lines: list[tuple[str, str]]) -> list[dict]:
    type_map = {"h1": "heading_1", "h2": "heading_2", "h3": "heading_3", "li": "bulleted_list_item", "p": "paragraph"}
    children: list[dict] = []
    for kind, text in lines:
        block_type = type_map.get(kind, "paragraph")
        children.append(
            {"object": "block", "type": block_type, block_type: {"rich_text": _notion_rich_text(text)}}
        )
    return children


def _send_notion(connector: dict, doc: dict, *, timeout: int) -> dict:
    name = _cfg(connector, "name")
    token_env = _cfg(connector, "token_env")
    if not token_env:
        raise ConnectorError(f"连接器「{name}」未配置 token_env。")
    token = _env_value(token_env)
    if not token:
        raise ConnectorError(f"连接器「{name}」的 Notion token 未设置（环境变量为空）。")

    database_id = _cfg(connector, "database_id")
    page_id = _cfg(connector, "page_id")
    if not database_id and not page_id:
        raise ConnectorError(f"连接器「{name}」需要配置 database_id 或 page_id。")

    title = str(doc.get("title", "")).strip() or "未命名稿件"
    body, truncated = _clip_body(doc, _connector_max_chars(connector))
    children = _notion_children(_structured_lines(body))
    if len(children) >= _MAX_DOC_BLOCKS:
        truncated = True

    if database_id:
        parent = {"database_id": database_id}
        properties = {_cfg(connector, "title_property", "Name"): {"title": _notion_rich_text(title)}}
    else:
        parent = {"page_id": page_id}
        properties = {"title": {"title": _notion_rich_text(title)}}

    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }
    payload = {"parent": parent, "properties": properties, "children": children}
    response = _post_json(
        f"{NOTION_BASE}/v1/pages", json_body=payload, headers=headers, timeout=timeout, label=f"连接器「{name}」"
    )
    if response.status_code >= 300:
        detail = _extract_error(response, default=f"HTTP {response.status_code}")
        logger.warning("Notion 页面创建失败 [%s]: %s", name, detail)
        raise ConnectorError(f"Notion 返回失败：{detail}")

    document_url = str((response.json() or {}).get("url", "") or "")
    return {
        "connector": name,
        "format": "notion",
        "kind": "doc",
        "truncated": truncated,
        "ok": True,
        "document_url": document_url,
    }


# ── 飞书/Lark 文档 ────────────────────────────────────────


def _feishu_base(connector: dict) -> str:
    return _cfg(connector, "base_url", FEISHU_DEFAULT_BASE).rstrip("/")


def _feishu_tenant_token(connector: dict, *, timeout: int) -> str:
    name = _cfg(connector, "name")
    app_id_env = _cfg(connector, "app_id_env")
    app_secret_env = _cfg(connector, "app_secret_env")
    if not app_id_env or not app_secret_env:
        raise ConnectorError(f"连接器「{name}」未配置 app_id_env / app_secret_env。")
    app_id = _env_value(app_id_env)
    app_secret = _env_value(app_secret_env)
    if not app_id or not app_secret:
        raise ConnectorError(f"连接器「{name}」的飞书应用凭据未设置（环境变量为空）。")

    base = _feishu_base(connector)
    response = _post_json(
        f"{base}/open-apis/auth/v3/tenant_access_token/internal",
        json_body={"app_id": app_id, "app_secret": app_secret},
        headers={"Content-Type": "application/json"},
        timeout=timeout,
        label=f"连接器「{name}」",
    )
    try:
        data = response.json()
    except Exception as exc:
        raise ConnectorError(f"连接器「{name}」获取飞书 token 失败：响应无法解析。") from exc
    if data.get("code") not in (0, None):
        raise ConnectorError(f"连接器「{name}」获取飞书 token 失败：{data.get('msg') or data.get('code')}")
    token = str(data.get("tenant_access_token", "") or "")
    if not token:
        raise ConnectorError(f"连接器「{name}」未获得飞书 tenant_access_token。")
    return token


def _feishu_blocks(lines: list[tuple[str, str]]) -> list[dict]:
    # 统一用文本块（block_type=2）保证兼容性；标题/列表也以文本呈现。
    blocks: list[dict] = []
    for _kind, text in lines:
        blocks.append({"block_type": 2, "text": {"elements": [{"text_run": {"content": text}}]}})
    return blocks


def _send_feishu_doc(connector: dict, doc: dict, *, timeout: int) -> dict:
    name = _cfg(connector, "name")
    base = _feishu_base(connector)
    token = _feishu_tenant_token(connector, timeout=timeout)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    title = str(doc.get("title", "")).strip() or "未命名稿件"
    body, truncated = _clip_body(doc, _connector_max_chars(connector))

    create_body: dict[str, Any] = {"title": title}
    folder_token = _cfg(connector, "folder_token")
    if folder_token:
        create_body["folder_token"] = folder_token
    create_resp = _post_json(
        f"{base}/open-apis/docx/v1/documents",
        json_body=create_body,
        headers=headers,
        timeout=timeout,
        label=f"连接器「{name}」",
    )
    create_data = _feishu_data(create_resp, name, "创建文档")
    document_id = str(((create_data.get("document") or {}).get("document_id")) or "")
    if not document_id:
        raise ConnectorError(f"连接器「{name}」创建飞书文档失败：未返回 document_id。")

    blocks = _feishu_blocks(_structured_lines(body))
    if len(blocks) >= _MAX_DOC_BLOCKS:
        truncated = True
    if blocks:
        insert_resp = _post_json(
            f"{base}/open-apis/docx/v1/documents/{document_id}/blocks/{document_id}/children",
            json_body={"index": 0, "children": blocks},
            headers=headers,
            timeout=timeout,
            label=f"连接器「{name}」",
        )
        _feishu_data(insert_resp, name, "写入文档内容")

    return {
        "connector": name,
        "format": "feishu-doc",
        "kind": "doc",
        "truncated": truncated,
        "ok": True,
        "document_id": document_id,
    }


def _feishu_data(response: httpx.Response, name: str, action: str) -> dict:
    if response.status_code >= 300:
        raise ConnectorError(f"连接器「{name}」{action}失败：HTTP {response.status_code}")
    try:
        data = response.json()
    except Exception as exc:
        raise ConnectorError(f"连接器「{name}」{action}失败：响应无法解析。") from exc
    if data.get("code") not in (0, None):
        raise ConnectorError(f"连接器「{name}」{action}失败：{data.get('msg') or data.get('code')}")
    return data.get("data") or {}


def _extract_error(response: httpx.Response, *, default: str) -> str:
    try:
        data = response.json()
    except Exception:
        return default
    if isinstance(data, dict):
        return str(data.get("message") or data.get("msg") or data.get("error") or default)
    return default


# ── 对外入口 ──────────────────────────────────────────────


def send_document(connector: dict, doc: dict, *, timeout: int = 20) -> dict:
    """把成稿发送到连接器目标。失败抛 :class:`ConnectorError`。"""
    fmt = _cfg(connector, "format", "markdown")
    if fmt in WEBHOOK_FORMATS:
        return _send_webhook(connector, doc, timeout=timeout)
    if fmt == "notion":
        return _send_notion(connector, doc, timeout=timeout)
    if fmt == "feishu-doc":
        return _send_feishu_doc(connector, doc, timeout=timeout)
    raise ConnectorError(f"不支持的连接器格式：{fmt}")


def test_connector(connector: dict, *, timeout: int = 15) -> dict:
    """预检连接器凭据/可达性，不产生正式内容。"""
    name = _cfg(connector, "name")
    fmt = _cfg(connector, "format", "markdown")

    if fmt in WEBHOOK_FORMATS:
        # Webhook 无安全的只读预检口：只校验已配置且地址为公网可达。
        url = _env_value(_cfg(connector, "url_env"))
        if not url:
            raise ConnectorError(f"连接器「{name}」的 Webhook 地址未设置。")
        try:
            validate_public_url(url)
        except UnsafeUrlError as exc:
            raise ConnectorError(f"连接器「{name}」地址不安全：{exc}") from exc
        return {"connector": name, "ok": True, "detail": "已配置（Webhook 无法只读预检，请以一次发送验证）"}

    if fmt == "notion":
        token = _env_value(_cfg(connector, "token_env"))
        if not token:
            raise ConnectorError(f"连接器「{name}」的 Notion token 未设置。")
        url = f"{NOTION_BASE}/v1/users/me"
        try:
            response = httpx.get(
                url,
                headers={"Authorization": f"Bearer {token}", "Notion-Version": NOTION_VERSION},
                timeout=timeout,
            )
        except httpx.HTTPError as exc:
            raise ConnectorError(f"连接器「{name}」预检失败：网络错误。") from exc
        if response.status_code >= 300:
            raise ConnectorError(f"连接器「{name}」预检失败：{_extract_error(response, default=f'HTTP {response.status_code}')}")
        return {"connector": name, "ok": True, "detail": "Notion 凭据有效"}

    if fmt == "feishu-doc":
        # 换取一次 tenant_access_token 即可验证应用凭据。
        _feishu_tenant_token(connector, timeout=timeout)
        return {"connector": name, "ok": True, "detail": "飞书应用凭据有效"}

    raise ConnectorError(f"不支持的连接器格式：{fmt}")
