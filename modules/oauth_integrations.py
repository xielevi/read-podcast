"""Google 文档与飞书文档的服务端 OAuth 授权流程。"""
from __future__ import annotations

import os
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode, urlparse

import httpx

from modules.network_security import UnsafeUrlError, validate_public_url
from modules.user_settings import SettingsError, write_integration_secrets


GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file"

FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
FEISHU_BASE_URL = "https://open.feishu.cn"
FEISHU_APP_TOKEN_PATH = "/open-apis/auth/v3/app_access_token/internal"
FEISHU_USER_TOKEN_PATH = "/open-apis/authen/v1/access_token"

STATE_TTL_SECONDS = 600
OAUTH_TIMEOUT_SECONDS = 20


class OAuthIntegrationError(RuntimeError):
    """OAuth 配置、授权或令牌交换失败。"""


@dataclass(frozen=True)
class ProviderSpec:
    key: str
    label: str
    client_id_env: str
    client_secret_env: str
    refresh_token_env: str
    access_token_env: str = ""


PROVIDERS = {
    "google": ProviderSpec(
        key="google",
        label="Google 文档",
        client_id_env="READ_PODCAST_CONNECTOR_GDRIVE_CLIENT_ID",
        client_secret_env="READ_PODCAST_CONNECTOR_GDRIVE_CLIENT_SECRET",
        refresh_token_env="READ_PODCAST_CONNECTOR_GDRIVE_REFRESH_TOKEN",
    ),
    "feishu": ProviderSpec(
        key="feishu",
        label="飞书文档",
        client_id_env="READ_PODCAST_CONNECTOR_FEISHU_APP_ID",
        client_secret_env="READ_PODCAST_CONNECTOR_FEISHU_APP_SECRET",
        refresh_token_env="READ_PODCAST_CONNECTOR_FEISHU_REFRESH_TOKEN",
        access_token_env="READ_PODCAST_CONNECTOR_FEISHU_ACCESS_TOKEN",
    ),
}


@dataclass
class PendingAuthorization:
    provider: str
    redirect_uri: str
    origin: str
    expires_at: float


_pending: dict[str, PendingAuthorization] = {}
_pending_lock = threading.Lock()


def _spec(provider: str) -> ProviderSpec:
    try:
        return PROVIDERS[provider]
    except KeyError as exc:
        raise OAuthIntegrationError("不支持的云文档账号") from exc


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def integration_status(provider: str) -> dict[str, Any]:
    spec = _spec(provider)
    return {
        "provider": spec.key,
        "label": spec.label,
        "app_configured": bool(_env(spec.client_id_env) and _env(spec.client_secret_env)),
        "connected": bool(_env(spec.refresh_token_env)),
    }


def integration_statuses() -> list[dict[str, Any]]:
    return [integration_status(provider) for provider in PROVIDERS]


def save_app_credentials(provider: str, client_id: str, client_secret: str) -> dict[str, Any]:
    spec = _spec(provider)
    if not str(client_id).strip() or not str(client_secret).strip():
        raise OAuthIntegrationError("应用 ID 与 Secret 都不能为空")
    try:
        write_integration_secrets(
            {
                spec.client_id_env: client_id,
                spec.client_secret_env: client_secret,
            }
        )
    except SettingsError as exc:
        raise OAuthIntegrationError(str(exc)) from exc
    return integration_status(provider)


def _validate_redirect_uri(provider: str, redirect_uri: str, request_origin: str) -> tuple[str, str]:
    parsed = urlparse(str(redirect_uri or ""))
    origin = urlparse(str(request_origin or ""))
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise OAuthIntegrationError("OAuth 回调地址无效")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise OAuthIntegrationError("OAuth 回调地址包含不允许的内容")
    if parsed.scheme != origin.scheme or parsed.netloc != origin.netloc:
        raise OAuthIntegrationError("OAuth 回调地址必须与当前页面同源")
    expected = f"/api/read-podcast/integrations/{provider}/callback"
    if not parsed.path.endswith(expected):
        raise OAuthIntegrationError("OAuth 回调路径不匹配")
    return parsed.geturl(), f"{origin.scheme}://{origin.netloc}"


def _new_state(provider: str, redirect_uri: str, origin: str) -> str:
    now = time.monotonic()
    state = secrets.token_urlsafe(32)
    with _pending_lock:
        expired = [key for key, item in _pending.items() if item.expires_at <= now]
        for key in expired:
            _pending.pop(key, None)
        _pending[state] = PendingAuthorization(
            provider=provider,
            redirect_uri=redirect_uri,
            origin=origin,
            expires_at=now + STATE_TTL_SECONDS,
        )
    return state


def begin_authorization(
    provider: str,
    redirect_uri: str,
    request_origin: str,
) -> dict[str, str]:
    spec = _spec(provider)
    client_id = _env(spec.client_id_env)
    if not client_id or not _env(spec.client_secret_env):
        raise OAuthIntegrationError("请先配置开发者应用 ID 与 Secret")
    redirect_uri, origin = _validate_redirect_uri(provider, redirect_uri, request_origin)
    state = _new_state(provider, redirect_uri, origin)

    if provider == "google":
        params = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": GOOGLE_SCOPE,
            "access_type": "offline",
            "include_granted_scopes": "true",
            "prompt": "consent",
            "state": state,
        }
        url = f"{GOOGLE_AUTHORIZE_URL}?{urlencode(params)}"
    else:
        params = {
            "app_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "state": state,
        }
        url = f"{FEISHU_AUTHORIZE_URL}?{urlencode(params)}"
    return {"provider": provider, "authorization_url": url}


def _consume_state(provider: str, state: str) -> PendingAuthorization:
    with _pending_lock:
        pending = _pending.pop(str(state or ""), None)
    if not pending or pending.provider != provider or pending.expires_at <= time.monotonic():
        raise OAuthIntegrationError("授权状态已失效，请重新登录")
    return pending


def _post_token(url: str, *, data: dict[str, str] | None = None, json: dict | None = None, headers: dict | None = None) -> dict:
    try:
        validate_public_url(url)
        response = httpx.post(
            url,
            data=data,
            json=json,
            headers=headers,
            timeout=OAUTH_TIMEOUT_SECONDS,
        )
    except (UnsafeUrlError, httpx.HTTPError) as exc:
        raise OAuthIntegrationError("无法连接授权服务") from exc
    try:
        payload = response.json()
    except Exception as exc:
        raise OAuthIntegrationError("授权服务响应无法解析") from exc
    if response.status_code >= 300:
        detail = payload.get("error_description") or payload.get("error") or response.status_code
        raise OAuthIntegrationError(f"授权服务拒绝令牌交换：{detail}")
    return payload if isinstance(payload, dict) else {}


def _exchange_google(code: str, pending: PendingAuthorization) -> None:
    spec = PROVIDERS["google"]
    payload = _post_token(
        GOOGLE_TOKEN_URL,
        data={
            "client_id": _env(spec.client_id_env),
            "client_secret": _env(spec.client_secret_env),
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": pending.redirect_uri,
        },
    )
    refresh_token = str(payload.get("refresh_token") or _env(spec.refresh_token_env)).strip()
    if not refresh_token:
        raise OAuthIntegrationError("Google 未返回刷新令牌，请重新同意授权")
    write_integration_secrets({spec.refresh_token_env: refresh_token})


def _feishu_app_access_token(spec: ProviderSpec) -> str:
    payload = _post_token(
        f"{FEISHU_BASE_URL}{FEISHU_APP_TOKEN_PATH}",
        json={"app_id": _env(spec.client_id_env), "app_secret": _env(spec.client_secret_env)},
    )
    if payload.get("code") not in (0, None):
        raise OAuthIntegrationError(f"飞书应用鉴权失败：{payload.get('msg') or payload.get('code')}")
    token = str(payload.get("app_access_token") or "")
    if not token:
        raise OAuthIntegrationError("飞书未返回 app_access_token")
    return token


def _exchange_feishu(code: str, _pending_item: PendingAuthorization) -> None:
    spec = PROVIDERS["feishu"]
    app_token = _feishu_app_access_token(spec)
    payload = _post_token(
        f"{FEISHU_BASE_URL}{FEISHU_USER_TOKEN_PATH}",
        json={"grant_type": "authorization_code", "code": code},
        headers={"Authorization": f"Bearer {app_token}", "Content-Type": "application/json"},
    )
    if payload.get("code") not in (0, None):
        raise OAuthIntegrationError(f"飞书用户授权失败：{payload.get('msg') or payload.get('code')}")
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    access_token = str(data.get("access_token") or "")
    refresh_token = str(data.get("refresh_token") or "")
    if not access_token or not refresh_token:
        raise OAuthIntegrationError("飞书未返回完整的用户令牌")
    write_integration_secrets(
        {
            spec.access_token_env: access_token,
            spec.refresh_token_env: refresh_token,
        }
    )


def complete_authorization(provider: str, code: str, state: str) -> dict[str, Any]:
    if not str(code or "").strip():
        raise OAuthIntegrationError("授权码为空")
    pending = _consume_state(provider, state)
    try:
        if provider == "google":
            _exchange_google(code, pending)
        elif provider == "feishu":
            _exchange_feishu(code, pending)
        else:
            raise OAuthIntegrationError("不支持的云文档账号")
    except SettingsError as exc:
        raise OAuthIntegrationError(str(exc)) from exc
    return {**integration_status(provider), "origin": pending.origin}


def cancel_authorization(provider: str, state: str) -> dict[str, str]:
    pending = _consume_state(provider, state)
    return {"provider": provider, "origin": pending.origin}


def effective_connectors(config: list | None) -> list[dict]:
    """显式配置优先；缺少对应格式时补入 OAuth 内置云文档连接器。"""
    result = [dict(item) for item in (config or []) if isinstance(item, dict)]
    formats = {str(item.get("format") or "") for item in result}
    if "gdrive" not in formats and (
        _env(PROVIDERS["google"].client_id_env) or _env(PROVIDERS["google"].refresh_token_env)
    ):
        result.append(
            {
                "name": "Google 文档",
                "format": "gdrive",
                "client_id_env": PROVIDERS["google"].client_id_env,
                "client_secret_env": PROVIDERS["google"].client_secret_env,
                "refresh_token_env": PROVIDERS["google"].refresh_token_env,
            }
        )
    if "feishu-doc" not in formats and (
        _env(PROVIDERS["feishu"].client_id_env) or _env(PROVIDERS["feishu"].refresh_token_env)
    ):
        result.append(
            {
                "name": "飞书文档",
                "format": "feishu-doc",
                "app_id_env": PROVIDERS["feishu"].client_id_env,
                "app_secret_env": PROVIDERS["feishu"].client_secret_env,
                "user_access_token_env": PROVIDERS["feishu"].access_token_env,
                "user_refresh_token_env": PROVIDERS["feishu"].refresh_token_env,
            }
        )
    return result
