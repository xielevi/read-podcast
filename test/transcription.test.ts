/**
 * Transcription Service 协议的 Cloudflare 侧：契约、客户端错误分类、source 预检、进度映射、重试延迟。
 * 业务重试的判断权在 Cloudflare：这里的分类表就是那个判断。
 */
import { describe, expect, it } from "vitest";
import {
  NON_RETRYABLE_PROVIDER_ERRORS,
  TranscriptionServiceError,
  taskErrorCodeForProvider,
  transcriptionRequestId,
  type TranscriptionSnapshot,
} from "../src/transcription/contract";
import { cancelTranscription, checkServiceHealth, fetchTranscriptionResult, parseSnapshot, pollTranscription, serviceHeaders, submitTranscription } from "../src/transcription/client";
import { SourceError, assertPublicAudioUrl, resolveTranscriptionSource, uploadIdFromAudioUrl, uploadObjectKeyFromAudioUrl } from "../src/transcription/source";
import { PRESIGNED_SOURCE_TTL_SECONDS } from "../src/transcription/r2_presign";
import { exponentialRetryDelay } from "../src/workflows/common";
import { mapProviderProgress } from "../src/workflows/transcription";
import { MAX_RAW_BYTES, MAX_UPLOAD_BYTES } from "../src/limits";
import { ACCESS_CLIENT_ID, ACCESS_CLIENT_SECRET, R2_ACCOUNT_ID, R2_BUCKET, R2_SECRET_ACCESS_KEY, SERVICE_URL, makeCloud, presignedParts } from "./helpers/cloud";

const env = () => makeCloud().env;
const body = { request_id: "t:a", source: { type: "url" as const, url: "https://cdn.example.com/a.mp3" } };
const snapshot = (extra: Record<string, unknown> = {}) => ({ request_id: "t:a", provider_request_id: "tsr_1", status: "queued", ...extra });
const respond = (status: number, data: unknown = {}, headers: Record<string, string> = {}) =>
  (async () => new Response(typeof data === "string" ? data : JSON.stringify(data), { status, headers })) as unknown as typeof fetch;

/** `YYYYMMDDTHHMMSSZ` → epoch ms（JS 的 Date 解析器不认识 SigV4 的紧凑格式）。 */
function isoFromAmzDate(amzDate: string): number {
  const iso = `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`;
  return new Date(iso).getTime();
}

async function failure(promise: Promise<unknown>): Promise<TranscriptionServiceError> {
  try {
    await promise;
  } catch (error) {
    return error as TranscriptionServiceError;
  }
  throw new Error("expected a failure");
}

describe("契约", () => {
  it("request_id 只由 Cloudflare 生成：同一 (task, attempt) 永远得到同一个键", () => {
    expect(transcriptionRequestId("task-1", "attempt-2")).toBe("task-1:attempt-2");
  });

  it("契约本身不含任何 Mac / 本机路径概念", () => {
    const text = JSON.stringify({ body, snapshot: snapshot() });
    expect(text).not.toMatch(/mac|launchd|mlx|\/Users\//i);
  });

  it.each([
    ["source_not_allowed", "source_not_allowed"],
    ["source_too_large", "source_too_large"],
    ["source_fetch_failed", "audio_download_failed"],
    ["transcription_empty", "transcription_invalid"],
    ["unsupported_source", "transcription_request_rejected"],
    ["engine_unavailable", "transcription_failed"],
    ["engine_failed", "transcription_failed"],
    ["something_new", "transcription_failed"],
  ])("provider 错误码 %s → 任务错误码 %s", (provider, task) => {
    expect(taskErrorCodeForProvider(provider)).toBe(task);
  });

  it("确定性失败集合：重试不会改变结论的原因", () => {
    for (const code of ["source_not_allowed", "source_too_large", "engine_rejected_audio", "transcription_empty", "unsupported_source", "invalid_request"]) {
      expect(NON_RETRYABLE_PROVIDER_ERRORS.has(code)).toBe(true);
    }
    for (const code of ["source_fetch_failed", "engine_unavailable", "engine_failed", "internal_error"]) {
      expect(NON_RETRYABLE_PROVIDER_ERRORS.has(code)).toBe(false);
    }
  });
});

describe("客户端：HTTP 错误分类（retryable 与否由 Cloudflare 判断）", () => {
  it.each([401, 403])("%i → non-retryable：鉴权配置错误", async status => {
    const error = await failure(submitTranscription(env(), body, respond(status)));
    expect(error).toMatchObject({ code: "transcription_service_auth", retryable: false, status });
  });

  it.each([400, 404, 409, 413, 415, 422])("%i → non-retryable：请求本身不被接受", async status => {
    const error = await failure(submitTranscription(env(), body, respond(status, { error: { code: "x", message: "nope" } })));
    expect(error).toMatchObject({ code: "transcription_request_rejected", retryable: false, status });
    expect(error.message).toContain("nope");
  });

  it.each([408, 425, 429, 500, 502, 503, 504])("%i → retryable", async status => {
    const error = await failure(submitTranscription(env(), body, respond(status)));
    expect(error).toMatchObject({ code: "transcription_service_unavailable", retryable: true, status });
  });

  it("429 的 Retry-After 被保留下来，供 durable retry 的延迟函数使用", async () => {
    const error = await failure(submitTranscription(env(), body, respond(429, {}, { "retry-after": "45" })));
    expect(error.retryAfterSeconds).toBe(45);
    const delay = exponentialRetryDelay({ ctx: { attempt: 1, step: { name: "s", count: 1 } }, error: Object.assign(new Error("x"), { retryAfterSeconds: 45 }) });
    expect(delay).toBe("45 seconds");
  });

  it("传输层：连不上 → unreachable（retryable）；超时 / abort → timeout（retryable）", async () => {
    const refused = await failure(submitTranscription(env(), body, (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch));
    expect(refused).toMatchObject({ kind: "unreachable", retryable: true });
    for (const name of ["TimeoutError", "AbortError"]) {
      const timeout = await failure(submitTranscription(env(), body, (async () => { throw new DOMException("t", name); }) as unknown as typeof fetch));
      expect(timeout).toMatchObject({ kind: "timeout", retryable: true });
    }
  });

  it("未配置 endpoint / 生产路径缺 Access 凭据 → non-retryable（transcription_service_unconfigured）", async () => {
    for (const patch of [{ TRANSCRIPTION_SERVICE_URL: "" }, { TRANSCRIPTION_SERVICE_URL: "ftp://x" }, { CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" }]) {
      const e = Object.assign(env(), patch);
      expect(await failure(submitTranscription(e, body, respond(200)))).toMatchObject({ code: "transcription_service_unconfigured", retryable: false });
    }
  });

  it("本地开发：endpoint 指向本机时不要求 Access 凭据；其余情况必须配置", () => {
    const local = Object.assign(env(), { TRANSCRIPTION_SERVICE_URL: "http://127.0.0.1:28100", CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" });
    expect(serviceHeaders(local).get("cf-access-client-id")).toBeNull();
    expect(() => serviceHeaders(Object.assign(env(), { CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" }))).toThrow(/CF_ACCESS_CLIENT_ID/);
    // 半配置（只有一半凭据）也是错误，不做静默降级
    expect(() => serviceHeaders(Object.assign(env(), { CF_ACCESS_CLIENT_SECRET: "" }))).toThrow(/CF_ACCESS_CLIENT_ID/);
  });

  it("请求头：Cloudflare Access service token（没有 application bearer token）", () => {
    const e = env();
    const headers = serviceHeaders(e);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cf-access-client-id")).toBe(ACCESS_CLIENT_ID);
    expect(headers.get("cf-access-client-secret")).toBe(ACCESS_CLIENT_SECRET);
    expect(serviceHeaders(e, true).get("content-type")).toBe("application/json");
  });

  it("提交：POST /v1/transcriptions，携带 JSON 体与 Access 凭据；去掉 URL 末尾斜杠", async () => {
    const e = Object.assign(env(), { TRANSCRIPTION_SERVICE_URL: `${SERVICE_URL}///` });
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(snapshot()), { status: 202 });
    }) as unknown as typeof fetch;

    const result = await submitTranscription(e, body, fetchFn);

    expect(result.provider_request_id).toBe("tsr_1");
    expect(seen!.url).toBe(`${SERVICE_URL}/v1/transcriptions`);
    expect(seen!.init.method).toBe("POST");
    expect(JSON.parse(String(seen!.init.body))).toEqual(body);
    const sent = new Headers(seen!.init.headers);
    expect(sent.get("cf-access-client-id")).toBe(ACCESS_CLIENT_ID);
    expect(sent.get("authorization")).toBeNull();
  });

  it("轮询：404 = 服务不认识该请求 → null（交给 Workflow 决定重新提交）；长轮询等待秒数被钳制", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const ref = { requestId: "t:a", providerRequestId: "tsr_1" };

    expect(await pollTranscription(env(), ref, 25, fetchFn)).toBeNull();
    await pollTranscription(env(), ref, 9999, fetchFn);
    await pollTranscription(env(), ref, -3, fetchFn);
    expect(urls.map(url => new URL(url).search)).toEqual(["?wait=25", "?wait=50", "?wait=0"]);
  });

  it("轮询：5xx 抛 retryable；请求路径对 provider id 做编码", async () => {
    const ref = { requestId: "t:a", providerRequestId: "tsr/../x" };
    const urls: string[] = [];
    const error = await failure(pollTranscription(env(), ref, 0, (async (url: string) => {
      urls.push(url);
      return new Response("x", { status: 503 });
    }) as unknown as typeof fetch));
    expect(error.retryable).toBe(true);
    expect(urls[0]).toContain("tsr%2F..%2Fx");
  });

  it("响应体过大（超过 raw 上限 + 余量）：拒收，不无限读取", async () => {
    const huge = "x".repeat(10 * 1024 * 1024);
    const error = await failure(submitTranscription(env(), body, respond(200, huge)));
    expect(error).toMatchObject({ code: "transcription_response_too_large", retryable: false });
  });

  it("取消：任何失败都被吞掉（best-effort），返回是否成功", async () => {
    expect(await cancelTranscription(env(), "tsr_1", respond(200))).toBe(true);
    expect(await cancelTranscription(env(), "tsr_1", respond(404))).toBe(false);
    expect(await cancelTranscription(env(), "tsr_1", (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toBe(false);
    expect(await cancelTranscription(Object.assign(env(), { TRANSCRIPTION_SERVICE_URL: "" }), "tsr_1", respond(200))).toBe(false);
  });

  it("健康探针：在线 / HTTP 错误 / 离线 / 未配置", async () => {
    const online = await checkServiceHealth(env(), respond(200, { status: "ok", engine: "mlx-api", active_requests: 2 }));
    expect(online).toMatchObject({ ok: true, engine: "mlx-api", activeRequests: 2 });
    expect(await checkServiceHealth(env(), respond(500))).toMatchObject({ ok: false, detail: "转录服务返回 HTTP 500" });
    expect(await checkServiceHealth(env(), (async () => { throw new TypeError("x"); }) as unknown as typeof fetch)).toMatchObject({ ok: false });
    expect(await checkServiceHealth(Object.assign(env(), { TRANSCRIPTION_SERVICE_URL: "" }))).toMatchObject({ ok: false });
  });

  it("健康探针打的是唯一的 /health，且经 Cloudflare Access（凭据错必须失败，不是显示「服务正常」）", async () => {
    const seen: string[] = [];
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new URL(String(input)).pathname);
      const headers = new Headers(init?.headers);
      return headers.get("cf-access-client-secret") === ACCESS_CLIENT_SECRET
        ? Response.json({ status: "ok", engine: "mlx-api" })
        : Response.json({ error: { code: "access_denied" } }, { status: 403 });
    }) as unknown as typeof fetch;

    expect(await checkServiceHealth(env(), spy)).toMatchObject({ ok: true });
    expect(seen).toEqual(["/health"]);

    const wrong = Object.assign(env(), { CF_ACCESS_CLIENT_SECRET: "wrong-secret" });
    expect(await checkServiceHealth(wrong, spy)).toMatchObject({ ok: false });
    expect((await checkServiceHealth(wrong, spy)).detail).toContain("Cloudflare Access");

    const missing = Object.assign(env(), { CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" });
    expect(await checkServiceHealth(missing, spy)).toMatchObject({ ok: false });
  });

  it("真实假服务：Access 凭据正确 ok，错误 403（探针不创建任何 transcription request）", async () => {
    const cloud = makeCloud();
    expect(await checkServiceHealth(cloud.env, cloud.fetch)).toMatchObject({ ok: true });

    (cloud.env as unknown as Record<string, string>).CF_ACCESS_CLIENT_SECRET = "wrong";
    expect(await checkServiceHealth(cloud.env, cloud.fetch)).toMatchObject({ ok: false });

    expect(cloud.service.posts).toEqual([]);
  });
});

describe("取回 raw 正文：单独端点、只取一次、有界读取", () => {
  const ref = { requestId: "t:a", providerRequestId: "tsr_1" };

  it("completed 后凭 /result 取回正文", async () => {
    const cloud = makeCloud();
    cloud.service.resultText = "真实转录正文";
    const job = { requestId: "t:a", providerRequestId: "tsr_1", source: { type: "url", url: "https://cdn.example.com/a.mp3" }, step: 4, cancelled: false };
    cloud.service.jobs.set("tsr_1", job);
    cloud.service.byRequestId.set("t:a", job);

    expect(await fetchTranscriptionResult(cloud.env, ref, cloud.fetch)).toBe("真实转录正文");
    expect(cloud.service.resultFetches).toBe(1);
  });

  it("服务不认识该请求（404）→ null，由 Workflow 决定重新提交", async () => {
    const cloud = makeCloud();
    expect(await fetchTranscriptionResult(cloud.env, ref, cloud.fetch)).toBeNull();
  });

  it("尚未完成（409 result_not_ready）→ non-retryable 协议级拒绝", async () => {
    const cloud = makeCloud();
    const job = { requestId: "t:a", providerRequestId: "tsr_1", source: { type: "url", url: "https://cdn.example.com/a.mp3" }, step: 0, cancelled: false };
    cloud.service.jobs.set("tsr_1", job);
    cloud.service.byRequestId.set("t:a", job);
    const error = await fetchTranscriptionResult(cloud.env, ref, cloud.fetch).then(() => null, (caught: TranscriptionServiceError) => caught);
    expect(error).toMatchObject({ code: "transcription_request_rejected", retryable: false, status: 409 });
  });

  it("响应超过 MAX_RAW_BYTES：中断读取并归类为 transcription_response_too_large", async () => {
    const cloud = makeCloud();
    const oversized = (async () =>
      new Response("x".repeat(MAX_RAW_BYTES + 1), { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    const error = await fetchTranscriptionResult(cloud.env, ref, oversized).then(() => null, (caught: TranscriptionServiceError) => caught);
    expect(error).toMatchObject({ code: "transcription_response_too_large", retryable: false });
  });
});

describe("快照校验：stale / 串线响应一律拒绝", () => {
  const expected = { requestId: "t:a", providerRequestId: "tsr_1" };
  const parse = (data: unknown, exp = expected) => parseSnapshot(JSON.stringify(data), exp);

  it("合法快照通过", () => {
    expect(parse(snapshot({ status: "running", progress: { phase: "transcribing", percent: 5 } })).status).toBe("running");
    expect(parse(snapshot({ status: "completed", result: { language: "zh", duration: 7200 } })).result).toEqual({ language: "zh", duration: 7200 });
  });

  it("completed 快照只带元数据：正文不属于状态响应（否则每次 poll 都要搬一遍 raw）", async () => {
    const cloud = makeCloud();
    cloud.service.steps = ["done"];
    cloud.service.resultText = "很长的转录正文".repeat(100);
    const job = { requestId: "t:a", providerRequestId: "tsr_1", source: { type: "url", url: "https://cdn.example.com/a.mp3" }, step: 0, cancelled: false };
    cloud.service.jobs.set("tsr_1", job);
    cloud.service.byRequestId.set("t:a", job);

    const snapshot = await pollTranscription(cloud.env, { requestId: "t:a", providerRequestId: "tsr_1" }, 0, cloud.fetch);

    expect(snapshot).toMatchObject({ status: "completed", result: { language: "zh", duration: 7200 } });
    expect(JSON.stringify(snapshot)).not.toContain("很长的转录正文");
    expect(cloud.service.resultFetches).toBe(0); // 轮询完全不碰正文
  });

  it.each([
    ["非 JSON", "not json"],
    ["缺 status", { request_id: "t:a", provider_request_id: "tsr_1" }],
    ["未知 status", snapshot({ status: "exploded" })],
    ["request_id 属于另一个请求", snapshot({ request_id: "other:req" })],
    ["provider_request_id 与期望不符", snapshot({ provider_request_id: "tsr_other" })],
    ["缺 provider_request_id", { request_id: "t:a", status: "queued" }],
    ["completed 却没有 result", snapshot({ status: "completed" })],
    ["completed 的 result 缺 duration", snapshot({ status: "completed", result: { language: "zh" } })],
    ["数组 / null", [null]],
  ])("%s → protocol error（non-retryable）", (_label, data) => {
    try {
      parseSnapshot(typeof data === "string" ? data : JSON.stringify(data), expected);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toMatchObject({ code: "transcription_protocol_error", retryable: false });
    }
  });

  it("提交响应不要求 provider id 预先已知，但 request_id 必须匹配", () => {
    expect(parseSnapshot(JSON.stringify(snapshot()), { requestId: "t:a" }).provider_request_id).toBe("tsr_1");
    expect(() => parseSnapshot(JSON.stringify(snapshot()), { requestId: "x:y" })).toThrow();
  });
});

describe("进度映射：转录服务上报子阶段，Cloudflare 决定全局进度", () => {
  const map = (progress?: TranscriptionSnapshot["progress"]) => mapProviderProgress({ request_id: "r", provider_request_id: "p", status: "running", progress });

  it.each([
    [{ phase: "queued", percent: 0 }, 0, null, "转录服务排队中…"],
    [undefined, 0, null, "转录服务排队中…"],
    [{ phase: "fetching", percent: 0 }, 0, "fetching", "正在获取音频…"],
    [{ phase: "fetching", percent: 100 }, 25, "fetching", "正在获取音频…"],
    [{ phase: "preparing", percent: 0 }, 25, "preparing", "正在准备音频…"],
    [{ phase: "transcribing", percent: 0 }, 25, "transcribing", "语音转录中 0%"],
    [{ phase: "transcribing", percent: 50, message: "Whisper 分片 3/6" }, 45, "transcribing", "语音转录中 50% · Whisper 分片 3/6"],
    [{ phase: "transcribing", percent: 100 }, 65, "transcribing", "语音转录中 100%"],
    [{ phase: "transcribing", percent: 999 }, 65, "transcribing", "语音转录中 100%"],
    [{ phase: "transcribing", percent: -5 }, 25, "transcribing", "语音转录中 0%"],
  ] as const)("%j → 全局 %i%%、phase=%s", (progress, global, phase, message) => {
    expect(map(progress as never)).toEqual({ progress: global, phase, message });
  });

  it("服务上报的自由文本被截断并折叠空白，不会撑爆 D1 / UI", () => {
    const mapped = map({ phase: "transcribing", percent: 1, message: `a\n\n  ${"b".repeat(500)}` });
    expect(mapped.message.length).toBeLessThan(140);
    expect(mapped.message).not.toMatch(/\n/);
  });
});

describe("durable retry 延迟：指数退避封顶 5 分钟", () => {
  const delay = (attempt: number) => exponentialRetryDelay({ ctx: { attempt, step: { name: "s", count: attempt } }, error: new Error("x") });
  it("10s / 20s / 40s … 封顶 300s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 30].map(delay)).toEqual(["10 seconds", "20 seconds", "40 seconds", "80 seconds", "160 seconds", "300 seconds", "300 seconds", "300 seconds", "300 seconds"]);
  });
});

describe("source 预检（防御纵深；权威的 SSRF 拦截在转录服务的抓取层）", () => {
  it.each([
    "https://cdn.example.com/a.mp3",
    "http://media.example.org:8080/path/a.m4a?token=abc",
    "https://93.184.216.34/a.mp3",
    "https://[2606:2800:220:1:248:1893:25c8:1946]/a.mp3",
  ])("放行公网地址 %s", url => {
    expect(() => assertPublicAudioUrl(url)).not.toThrow();
  });

  it.each([
    // scheme / 凭据
    "file:///etc/passwd", "ftp://cdn.example.com/a.mp3", "gopher://x/", "javascript:alert(1)", "not a url", "",
    "https://user:pass@cdn.example.com/a.mp3",
    // localhost 与内部主机名
    "http://localhost/a.mp3", "http://localhost./a.mp3", "http://foo.localhost/a.mp3", "http://printer.local/a.mp3",
    "http://db.internal/a.mp3", "http://router.lan/a.mp3", "http://intranet/a.mp3",
    // IPv4 私网 / 保留
    "http://127.0.0.1/a.mp3", "http://127.9.9.9/a.mp3", "http://10.0.0.5/a.mp3", "http://172.16.0.1/a.mp3", "http://172.31.255.255/a.mp3",
    "http://192.168.1.1/a.mp3", "http://169.254.169.254/latest/meta-data", "http://0.0.0.0/a.mp3", "http://100.64.0.1/a.mp3",
    "http://198.18.0.1/a.mp3", "http://224.0.0.1/a.mp3", "http://255.255.255.255/a.mp3",
    // IPv4 的十进制 / 十六进制 / 八进制写法（URL 解析器会规范化成点分十进制）
    "http://2130706433/a.mp3", "http://0x7f000001/a.mp3", "http://0x7f.1/a.mp3", "http://017700000001/a.mp3", "http://127.1/a.mp3",
    // IPv6：回环 / 未指定 / ULA / link-local / 多播
    "http://[::1]/a.mp3", "http://[::]/a.mp3", "http://[fc00::1]/a.mp3", "http://[fd12:3456::1]/a.mp3", "http://[fe80::1]/a.mp3", "http://[ff02::1]/a.mp3",
    // IPv4 内嵌形式（映射 / 兼容 / NAT64 / 6to4）
    "http://[::ffff:127.0.0.1]/a.mp3", "http://[::ffff:7f00:1]/a.mp3", "http://[::ffff:10.0.0.5]/a.mp3", "http://[::ffff:a9fe:a9fe]/a.mp3",
    "http://[::127.0.0.1]/a.mp3", "http://[64:ff9b::7f00:1]/a.mp3", "http://[64:ff9b::a00:5]/a.mp3", "http://[2002:7f00:1::1]/a.mp3", "http://[2002:a9fe:a9fe::1]/a.mp3",
  ])("拒绝 %s", url => {
    expect(() => assertPublicAudioUrl(url)).toThrow(SourceError);
    try {
      assertPublicAudioUrl(url);
    } catch (error) {
      expect((error as SourceError).code).toBe("source_not_allowed");
    }
  });

  it("IPv4 内嵌但目标是公网的写法不被误杀", () => {
    expect(() => assertPublicAudioUrl("http://[::ffff:5db8:d822]/a.mp3")).not.toThrow(); // ::ffff:93.184.216.34
    expect(() => assertPublicAudioUrl("http://[2002:5db8:d822::1]/a.mp3")).not.toThrow();
  });

  it("uploadIdFromAudioUrl 只认 r2://uploads/<id>/…", () => {
    expect(uploadIdFromAudioUrl("r2://uploads/up-1/a.mp3")).toBe("up-1");
    expect(uploadIdFromAudioUrl("https://x/uploads/up-1/a.mp3")).toBe("");
    expect(uploadIdFromAudioUrl(null)).toBe("");
  });

  it("uploadObjectKeyFromAudioUrl 只接受恰好三段的确切 key（身份来自保存的 key，不做 prefix 模糊查找）", () => {
    expect(uploadObjectKeyFromAudioUrl("r2://uploads/up-1/a.mp3")).toBe("uploads/up-1/a.mp3");
    expect(uploadObjectKeyFromAudioUrl("r2://uploads/up-1/我的录音 v2.mp3")).toBe("uploads/up-1/我的录音 v2.mp3");

    for (const bad of [
      "https://x/uploads/up-1/a.mp3", // 不是 r2://
      "r2://raw/up-1/a.mp3", // 不是 uploads/ 前缀
      "r2://uploads/up-1", // 缺文件名
      "r2://uploads/up-1/a/b.mp3", // 多段
      "r2://uploads//a.mp3", // 空 upload_id
      "r2://uploads/up-1/", // 空文件名
      "r2://uploads/../a.mp3", // 上跳
      "r2://uploads/up-1/..", // 上跳
      "",
    ]) {
      expect(uploadObjectKeyFromAudioUrl(bad), bad).toBe("");
    }
    expect(uploadObjectKeyFromAudioUrl(null)).toBe("");
  });
});

describe("音频 source：RSS 公网 URL 与 R2 presigned GET", () => {
  it("RSS 任务：直接给出公网音频 URL（并在本地先做字面量预检）", async () => {
    const cloud = makeCloud();
    expect(await resolveTranscriptionSource(cloud.env, { source_type: "rss", audio_url: "https://cdn.example.com/a.mp3" })).toEqual({
      type: "url",
      url: "https://cdn.example.com/a.mp3",
    });
    await expect(resolveTranscriptionSource(cloud.env, { source_type: "rss", audio_url: "http://10.0.0.5/a.mp3" })).rejects.toMatchObject({ code: "source_not_allowed" });
    expect(cloud.r2.keys()).toEqual([]);
  });

  it("自定义上传：给出指向**确切对象**的 R2 presigned GET，且只 GET、限定 max_bytes", async () => {
    const cloud = makeCloud();
    const before = Date.now();
    cloud.r2.putSized("uploads/up-1/talk.mp3", 4_096);

    const source = await resolveTranscriptionSource(cloud.env, { source_type: "upload", audio_url: "r2://uploads/up-1/talk.mp3" });

    expect(source.type).toBe("url");
    expect(source.max_bytes).toBe(MAX_UPLOAD_BYTES);
    const { origin, key, params } = presignedParts(source.url);
    expect(origin).toBe(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(key).toBe(`/${R2_BUCKET}/uploads/up-1/talk.mp3`);
    expect(params.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(params.get("X-Amz-SignedHeaders")).toBe("host");
    expect(params.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // 只读：签发路径本身固定为 GET，URL 里没有任何写操作参数
    expect([...params.keys()].sort()).toEqual([
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
    ]);

    // 有效期：覆盖 submission + 排队 + 下载，而不是整段转录
    const expires = Number(params.get("X-Amz-Expires"));
    expect(expires).toBe(PRESIGNED_SOURCE_TTL_SECONDS);
    expect(expires).toBeGreaterThanOrEqual(3600);
    expect(expires).toBeLessThanOrEqual(2 * 3600);
    const amzDate = params.get("X-Amz-Date")!;
    expect(amzDate).toMatch(/^\d{8}T\d{6}Z$/);
    expect(Number(amzDate.slice(0, 4))).toBe(new Date(before).getUTCFullYear());
    expect(isoFromAmzDate(amzDate)).toBeGreaterThanOrEqual(before - 60_000);
    expect(isoFromAmzDate(amzDate)).toBeLessThanOrEqual(Date.now() + 60_000);

    // 凭据 scope 绑定到签发者的 access key id
    expect(params.get("X-Amz-Credential")).toMatch(/^AKIATESTACCESSKEYID\/\d{8}\/auto\/s3\/aws4_request$/);
  });

  it("同一个 key 相同时间戳 → 完全相同的 URL（确定性，便于 durable step 断言）", async () => {
    const cloud = makeCloud();
    cloud.r2.putSized("uploads/up-1/talk.mp3", 4_096);
    const task = { source_type: "upload" as const, audio_url: "r2://uploads/up-1/talk.mp3" };
    const at = Date.UTC(2026, 8, 21, 10, 0, 0);
    const first = await resolveTranscriptionSource(cloud.env, task, at);
    const second = await resolveTranscriptionSource(cloud.env, task, at);
    expect(first.url).toBe(second.url);
  });

  it("签名 URL 不含任何 R2 凭据材料（只带 access key id 与时间戳）", async () => {
    const cloud = makeCloud();
    cloud.r2.putSized("uploads/up-1/talk.mp3", 4_096);
    const source = await resolveTranscriptionSource(cloud.env, { source_type: "upload", audio_url: "r2://uploads/up-1/talk.mp3" });
    expect(source.url).not.toContain(R2_SECRET_ACCESS_KEY);
    expect(source.url).not.toContain(ACCESS_CLIENT_SECRET);
  });

  it("对象不存在 → upload_expired（不签发任何 URL）", async () => {
    const cloud = makeCloud();
    await expect(resolveTranscriptionSource(cloud.env, { source_type: "upload", audio_url: "r2://uploads/gone/talk.mp3" })).rejects.toMatchObject({ code: "upload_expired" });
  });

  it("audio_url 形状不合法 → upload_expired（不做 prefix 模糊查找兜底）", async () => {
    const cloud = makeCloud();
    cloud.r2.putSized("uploads/up-1/talk.mp3", 4_096);
    for (const bad of ["r2://uploads/up-1", "r2://uploads/up-1/a/b.mp3", "https://x/uploads/up-1/a.mp3"]) {
      await expect(resolveTranscriptionSource(cloud.env, { source_type: "upload", audio_url: bad })).rejects.toMatchObject({ code: "upload_expired" });
    }
  });

  it("对象超过 200 MiB：**签名之前**就拒绝（source_too_large）", async () => {
    const cloud = makeCloud();
    cloud.r2.putSized("uploads/big/talk.mp3", MAX_UPLOAD_BYTES + 1);
    await expect(resolveTranscriptionSource(cloud.env, { source_type: "upload", audio_url: "r2://uploads/big/talk.mp3" })).rejects.toMatchObject({ code: "source_too_large" });
  });

  it("恰好 200 MiB 的对象仍然可以签发（硬上限是 ≤）", async () => {
    const cloud = makeCloud();
    cloud.r2.putSized("uploads/exact/talk.mp3", MAX_UPLOAD_BYTES);
    const source = await resolveTranscriptionSource(cloud.env, { source_type: "upload", audio_url: "r2://uploads/exact/talk.mp3" });
    expect(presignedParts(source.url).key).toBe(`/${R2_BUCKET}/uploads/exact/talk.mp3`);
  });

  it("Cloudflare 侧缺少 R2 签发凭据 → r2_credentials_unconfigured（可行动的部署错误，不是任务问题）", async () => {
    for (const missing of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]) {
      const cloud = makeCloud();
      cloud.r2.putSized("uploads/up-1/talk.mp3", 4_096);
      (cloud.env as unknown as Record<string, string>)[missing] = "";
      await expect(
        resolveTranscriptionSource(cloud.env, { source_type: "upload", audio_url: "r2://uploads/up-1/talk.mp3" }),
        missing,
      ).rejects.toMatchObject({ code: "r2_credentials_unconfigured" });
    }
  });

  it("RSS 任务不需要 R2 凭据（凭据缺失只影响自定义上传）", async () => {
    const cloud = makeCloud();
    (cloud.env as unknown as Record<string, string>).R2_SECRET_ACCESS_KEY = "";
    await expect(resolveTranscriptionSource(cloud.env, { source_type: "rss", audio_url: "https://cdn.example.com/a.mp3" })).resolves.toMatchObject({ type: "url" });
  });
});
