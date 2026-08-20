from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from app.standalone import app
from modules import oauth_integrations as oauth


OAUTH_ENV_KEYS = [
    spec.client_id_env
    for spec in oauth.PROVIDERS.values()
] + [
    spec.client_secret_env
    for spec in oauth.PROVIDERS.values()
] + [
    spec.refresh_token_env
    for spec in oauth.PROVIDERS.values()
] + [oauth.PROVIDERS["feishu"].access_token_env]


def _clear_oauth(monkeypatch):
    for key in OAUTH_ENV_KEYS:
        if key:
            monkeypatch.delenv(key, raising=False)
    oauth._pending.clear()


def test_integration_status_never_returns_credentials(monkeypatch):
    _clear_oauth(monkeypatch)
    spec = oauth.PROVIDERS["google"]
    monkeypatch.setenv(spec.client_id_env, "client-id")
    monkeypatch.setenv(spec.client_secret_env, "client-secret")
    monkeypatch.setenv(spec.refresh_token_env, "refresh-token")

    status = oauth.integration_status("google")

    assert status == {
        "provider": "google",
        "label": "Google 文档",
        "app_configured": True,
        "connected": True,
    }
    assert "client-id" not in str(status)
    assert "refresh-token" not in str(status)


def test_google_authorization_callback_stores_refresh_token(monkeypatch):
    _clear_oauth(monkeypatch)
    spec = oauth.PROVIDERS["google"]
    monkeypatch.setenv(spec.client_id_env, "client-id")
    monkeypatch.setenv(spec.client_secret_env, "client-secret")
    monkeypatch.setattr(oauth, "validate_public_url", lambda _url: _url)
    monkeypatch.setattr(
        oauth,
        "write_integration_secrets",
        lambda updates: [monkeypatch.setenv(key, value) for key, value in updates.items()],
    )

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {"access_token": "access-token", "refresh_token": "refresh-token"}

    monkeypatch.setattr(oauth.httpx, "post", lambda *args, **kwargs: Response())
    redirect_uri = "http://testserver/api/read-podcast/integrations/google/callback"
    started = oauth.begin_authorization("google", redirect_uri, "http://testserver")
    query = parse_qs(urlparse(started["authorization_url"]).query)

    assert query["scope"] == [oauth.GOOGLE_SCOPE]
    assert query["access_type"] == ["offline"]
    completed = oauth.complete_authorization("google", "code-1", query["state"][0])

    assert completed["connected"] is True
    assert oauth._env(spec.refresh_token_env) == "refresh-token"
    assert query["state"][0] not in oauth._pending


def test_oauth_state_is_single_use(monkeypatch):
    _clear_oauth(monkeypatch)
    spec = oauth.PROVIDERS["google"]
    monkeypatch.setenv(spec.client_id_env, "client-id")
    monkeypatch.setenv(spec.client_secret_env, "client-secret")
    started = oauth.begin_authorization(
        "google",
        "http://testserver/api/read-podcast/integrations/google/callback",
        "http://testserver",
    )
    state = parse_qs(urlparse(started["authorization_url"]).query)["state"][0]

    oauth.cancel_authorization("google", state)

    try:
        oauth.cancel_authorization("google", state)
    except oauth.OAuthIntegrationError as exc:
        assert "失效" in str(exc)
    else:
        raise AssertionError("OAuth state must be single-use")


def test_feishu_authorization_callback_stores_user_tokens(monkeypatch):
    _clear_oauth(monkeypatch)
    spec = oauth.PROVIDERS["feishu"]
    monkeypatch.setenv(spec.client_id_env, "app-id")
    monkeypatch.setenv(spec.client_secret_env, "app-secret")
    monkeypatch.setattr(oauth, "validate_public_url", lambda _url: _url)
    monkeypatch.setattr(
        oauth,
        "write_integration_secrets",
        lambda updates: [monkeypatch.setenv(key, value) for key, value in updates.items()],
    )

    class Response:
        status_code = 200

        def __init__(self, payload):
            self.payload = payload

        def json(self):
            return self.payload

    def fake_post(url, **_kwargs):
        if url.endswith(oauth.FEISHU_APP_TOKEN_PATH):
            return Response({"code": 0, "app_access_token": "app-token"})
        return Response(
            {
                "code": 0,
                "data": {"access_token": "user-token", "refresh_token": "user-refresh"},
            }
        )

    monkeypatch.setattr(oauth.httpx, "post", fake_post)
    redirect_uri = "http://testserver/api/read-podcast/integrations/feishu/callback"
    started = oauth.begin_authorization("feishu", redirect_uri, "http://testserver")
    query = parse_qs(urlparse(started["authorization_url"]).query)

    completed = oauth.complete_authorization("feishu", "code-1", query["state"][0])

    assert completed["connected"] is True
    assert oauth._env(spec.access_token_env) == "user-token"
    assert oauth._env(spec.refresh_token_env) == "user-refresh"


def test_oauth_rejects_cross_origin_callback(monkeypatch):
    _clear_oauth(monkeypatch)
    spec = oauth.PROVIDERS["google"]
    monkeypatch.setenv(spec.client_id_env, "client-id")
    monkeypatch.setenv(spec.client_secret_env, "client-secret")

    try:
        oauth.begin_authorization(
            "google",
            "https://attacker.example/api/read-podcast/integrations/google/callback",
            "http://testserver",
        )
    except oauth.OAuthIntegrationError as exc:
        assert "同源" in str(exc)
    else:
        raise AssertionError("cross-origin callback must be rejected")


def test_integrations_api_and_callback_page(monkeypatch):
    _clear_oauth(monkeypatch)
    spec = oauth.PROVIDERS["google"]
    monkeypatch.setattr(
        oauth,
        "write_integration_secrets",
        lambda updates: [monkeypatch.setenv(key, value) for key, value in updates.items()],
    )
    monkeypatch.setattr(oauth, "validate_public_url", lambda _url: _url)

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {"access_token": "access-token", "refresh_token": "refresh-token"}

    monkeypatch.setattr(oauth.httpx, "post", lambda *args, **kwargs: Response())

    with TestClient(app) as client:
        saved = client.put(
            "/api/read-podcast/integrations/google/app",
            json={"client_id": "client-id", "client_secret": "client-secret"},
        )
        started = client.post(
            "/api/read-podcast/integrations/google/authorize",
            json={"redirect_uri": "http://testserver/api/read-podcast/integrations/google/callback"},
        )
        state = parse_qs(urlparse(started.json()["authorization_url"]).query)["state"][0]
        callback = client.get(
            "/api/read-podcast/integrations/google/callback",
            params={"code": "code-1", "state": state},
        )
        statuses = client.get("/api/read-podcast/integrations")

    assert saved.status_code == 200
    assert started.status_code == 200
    assert callback.status_code == 200
    assert "read-podcast-oauth" in callback.text
    assert "refresh-token" not in callback.text
    google = next(item for item in statuses.json() if item["provider"] == "google")
    assert google["connected"] is True
    assert oauth._env(spec.refresh_token_env) == "refresh-token"
