"""Transcription Service HTTP 协议（Cloudflare-facing contract）。

契约与部署无关：不依赖共享文件系统、不依赖 Mac 路径 / launchd / MLX 本地路径——
只有 HTTP + JSON。任何满足本协议的实现都可以被 Cloudflare 无差别地调用。

零配置不变式：服务在**空环境**（无 .env、无 config.yaml、无任何 token）下照常工作；
不存在任何 application bearer token；``/health`` 是唯一的健康端点。
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from core.downloader import SourceTooLarge
from core.transcriber import TranscriptionResult
from jobs import JobManager
from service import create_app

URL = "https://cdn.example.com/ep/1.mp3"


class FakeDownloader:
    behavior = None

    def __init__(self, directory):
        self.directory = Path(directory)

    def download_audio(self, url, filename_base, max_bytes=None):
        if FakeDownloader.behavior:
            FakeDownloader.behavior(url, max_bytes)
        path = self.directory / f"{filename_base}.mp3"
        path.write_bytes(b"audio")
        return str(path)


class FakeTranscriber:
    gate: threading.Event | None = None

    def transcribe(self, audio_file, progress_callback=None, language=None):
        if progress_callback:
            progress_callback("transcribing", 40, "chunk 2/5")
        if FakeTranscriber.gate is not None:
            FakeTranscriber.gate.wait(timeout=5)
        return TranscriptionResult(text="转录内容。" * 60, language=language or "zh", duration=42.0)


@pytest.fixture(autouse=True)
def reset_fakes():
    """零配置不变式：正常服务不需要任何环境变量，只需要重置测试替身。"""
    FakeDownloader.behavior = None
    FakeTranscriber.gate = None


@pytest.fixture
def client(tmp_path):
    manager = JobManager(tmp_path, transcriber_factory=FakeTranscriber, downloader_factory=FakeDownloader)
    with TestClient(create_app(manager)) as test_client:
        yield test_client


def submit(client, request_id="task-1:attempt-1", url=URL, **extra):
    body = {"request_id": request_id, "source": {"type": "url", "url": url}, **extra}
    return client.post("/v1/transcriptions", json=body)


def wait_until(client, provider_id, predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while True:
        body = client.get(f"/v1/transcriptions/{provider_id}").json()
        if predicate(body):
            return body
        assert time.monotonic() < deadline, body
        time.sleep(0.02)


# ── health contract ──

def test_health_is_the_only_health_endpoint_and_exposes_no_secrets(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok" and body["protocol"] == 1
    assert "authorization" not in {key.lower() for key in response.headers}

    # 旧的双 health 已删除：/v1/health 不再存在
    assert client.get("/v1/health").status_code == 404


# ── 无认证（认证由 Cloudflare Access 承担） ──

def test_v1_endpoints_need_no_application_token(client):
    """reference deployment 的远程认证由 Cloudflare Access 承担；服务自身不验任何 token。"""
    body = submit(client).json()
    pid = body["provider_request_id"]
    wait_until(client, pid, lambda b: b["status"] == "completed")
    assert client.get(f"/v1/transcriptions/{pid}").status_code == 200
    assert client.get(f"/v1/transcriptions/{pid}/result").status_code == 200
    assert client.delete(f"/v1/transcriptions/{pid}").status_code == 200


def test_service_source_holds_no_auth_machinery():
    """架构护栏：不存在 bearer token 校验、第二配置中心或 YAML / dotenv 加载。"""
    source = Path(__file__).with_name("service.py").read_text(encoding="utf-8")
    for forbidden in ("_authorize", "Bearer", "hmac", "yaml", "dotenv"):
        assert forbidden not in source


# ── 协议（与删除前完全一致） ──

def test_submit_returns_202_and_a_provider_request_id(client):
    response = submit(client, options={"language": "zh"})
    assert response.status_code == 202
    body = response.json()
    assert body["request_id"] == "task-1:attempt-1"
    assert body["provider_request_id"].startswith("tsr_")
    assert body["status"] in {"queued", "running", "completed"}


def test_completed_snapshot_carries_metadata_only(client):
    """状态响应刻意不含正文：轮询上百次，正文只在 /result 取一次。"""
    body = submit(client, options={"language": "zh"}).json()
    done = wait_until(client, body["provider_request_id"], lambda b: b["status"] == "completed")
    assert done["request_id"] == "task-1:attempt-1"
    assert set(done["result"]) == {"language", "duration"}
    assert done["result"]["language"] == "zh" and done["result"]["duration"] == 42.0
    assert done["progress"]["percent"] == 100
    assert "转录内容" not in json.dumps(done, ensure_ascii=False)


def test_result_endpoint_returns_plain_text_once_completed(client):
    body = submit(client).json()
    pid = body["provider_request_id"]
    wait_until(client, pid, lambda b: b["status"] == "completed")

    response = client.get(f"/v1/transcriptions/{pid}/result")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert response.text == "转录内容。" * 60


def test_result_endpoint_before_completion_is_conflict(client):
    FakeTranscriber.gate = threading.Event()
    pid = submit(client).json()["provider_request_id"]
    wait_until(client, pid, lambda b: b["progress"]["phase"] == "transcribing")

    response = client.get(f"/v1/transcriptions/{pid}/result")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "result_not_ready"
    FakeTranscriber.gate.set()


def test_result_endpoint_is_404_for_an_unknown_request(client):
    response = client.get("/v1/transcriptions/tsr_unknown/result")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "unknown_request"


def test_result_endpoint_gone_after_release(client):
    pid = submit(client).json()["provider_request_id"]
    wait_until(client, pid, lambda b: b["status"] == "completed")
    assert client.get(f"/v1/transcriptions/{pid}/result").status_code == 200

    assert client.delete(f"/v1/transcriptions/{pid}").status_code == 200

    # 释放后结果与状态一起消失——/result 不引入任何 provider 侧业务状态
    assert client.get(f"/v1/transcriptions/{pid}/result").status_code == 404
    assert client.get(f"/v1/transcriptions/{pid}").status_code == 404


def test_duplicate_submit_is_idempotent(client):
    first = submit(client)
    second = submit(client)
    assert first.status_code == 202 and second.status_code == 200
    assert first.json()["provider_request_id"] == second.json()["provider_request_id"]


def test_same_request_id_with_other_source_is_409(client):
    submit(client)
    response = submit(client, url="https://cdn.example.com/other.mp3")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "request_conflict"


def test_only_url_sources_are_supported(client):
    response = client.post(
        "/v1/transcriptions",
        json={"request_id": "r1", "source": {"type": "file", "url": "/etc/passwd"}},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "unsupported_source"


@pytest.mark.parametrize("body", [{}, {"request_id": "r1"}, {"request_id": "r1", "source": {"type": "url"}}])
def test_malformed_requests_are_rejected_before_any_work(client, body):
    assert client.post("/v1/transcriptions", json=body).status_code == 422


def test_source_limit_from_the_caller_reaches_the_fetcher(client):
    seen = {}

    def record(url, max_bytes):
        seen["max_bytes"] = max_bytes

    FakeDownloader.behavior = record
    body = submit(client, request_id="r-limit", **{"source": {"type": "url", "url": URL, "max_bytes": 209_715_200}}).json()
    wait_until(client, body["provider_request_id"], lambda b: b["status"] == "completed")
    assert seen["max_bytes"] == 209_715_200


def test_failure_reports_a_stable_error_code(client):
    def too_large(url, max_bytes):
        raise SourceTooLarge("too big")

    FakeDownloader.behavior = too_large
    body = submit(client).json()
    failed = wait_until(client, body["provider_request_id"], lambda b: b["status"] == "failed")
    assert failed["error"]["code"] == "source_too_large"
    assert "result" not in failed


def test_unknown_request_is_404_so_the_caller_can_resubmit(client):
    response = client.get("/v1/transcriptions/tsr_unknown")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "unknown_request"


def test_long_poll_returns_early_when_the_request_finishes(client):
    FakeTranscriber.gate = threading.Event()
    body = submit(client).json()
    pid = body["provider_request_id"]
    wait_until(client, pid, lambda b: b["progress"]["phase"] == "transcribing" and b["progress"]["percent"] == 40)

    timer = threading.Timer(0.2, FakeTranscriber.gate.set)
    timer.start()
    started = time.monotonic()
    while True:
        response = client.get(f"/v1/transcriptions/{pid}?wait=30").json()
        if response["status"] == "completed":
            break
        assert time.monotonic() - started < 10
    assert time.monotonic() - started < 5  # 远小于 wait=30：状态变化即返回
    timer.cancel()


def test_wait_is_capped_below_typical_proxy_idle_timeouts(client):
    from service import MAX_WAIT_SECONDS

    assert MAX_WAIT_SECONDS < 100


def test_cancel_is_idempotent_and_releases_the_request(client):
    FakeTranscriber.gate = threading.Event()
    body = submit(client).json()
    pid = body["provider_request_id"]
    wait_until(client, pid, lambda b: b["progress"]["phase"] == "transcribing")

    cancelled = client.delete(f"/v1/transcriptions/{pid}")
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    assert client.get(f"/v1/transcriptions/{pid}").json()["status"] == "cancelled"

    FakeTranscriber.gate.set()
    # 再次释放（终态 → 忘记结果）；之后 404。
    assert client.delete(f"/v1/transcriptions/{pid}").status_code == 200
    assert client.get(f"/v1/transcriptions/{pid}").status_code == 404


def test_service_never_calls_out_to_cloudflare():
    """架构护栏：服务端没有回调 / 对账 / Cloudflare 凭据。"""
    source = Path(__file__).with_name("service.py").read_text(encoding="utf-8")
    for forbidden in ("EDGE_URL", "CALLBACK", "reconcile", "reclaim", "/api/internal", "raw_store", "jobs/start"):
        assert forbidden not in source
