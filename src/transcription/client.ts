import {
  HEALTH_PATH,
  TRANSCRIPTIONS_PATH,
  TRANSCRIPTION_RESULT_SUFFIX,
  TranscriptionServiceError,
  type TranscriptionRequestBody,
  type TranscriptionSnapshot,
} from "./contract";
import {
  cancelDashscopeTranscription,
  fetchDashscopeTranscriptionResult,
  pollDashscopeTranscription,
  submitDashscopeTranscription,
} from "./dashscope";
import { MAX_RAW_BYTES } from "../limits";
import { readBoundedText } from "../net/bounded";
import type { Env } from "../types";

/**
 * Transcription 的 Cloudflare 侧客户端入口：按部署变量 `TRANSCRIPTION_PROVIDER` 分发。
 *
 *   - self-hosted（默认）：经 Cloudflare Access 调用自托管 Transcription Service（本文件其余部分）；
 *   - dashscope：把同一组函数语义翻译为百炼 Paraformer 异步任务 API（见 dashscope.ts）。
 *
 * 两个实现共享同一组函数签名与快照契约，Workflow 与设置探针对此无感知；遵守「不提前加抽象」，
 * 只做这两个实现，没有服务商注册表。
 */

export type TranscriptionProvider = "self-hosted" | "dashscope";

/** 读取部署变量；未设置 / self-hosted 以外的合法值只有 dashscope，其余显式报错（不静默回落）。 */
export function transcriptionProvider(env: Env): TranscriptionProvider {
  const raw = (env.TRANSCRIPTION_PROVIDER ?? "").trim().toLowerCase();
  if (!raw || raw === "self-hosted") return "self-hosted";
  if (raw === "dashscope") return "dashscope";
  throw new TranscriptionServiceError(
    "unconfigured",
    "transcription_provider_unknown",
    `TRANSCRIPTION_PROVIDER must be self-hosted or dashscope (got ${raw})`,
    false,
  );
}

/**
 * Transcription Service 的 HTTP 客户端（Cloudflare → 转录服务）。
 *
 * 认证：reference production path 由 **Cloudflare Access** 保护（Tunnel 入口的 service
 * token），Cloudflare 侧只保存 `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`；Mac 上
 * 不存在任何 application credential。本地开发把 endpoint 指向本机（127.0.0.1 / localhost）
 * 时可以不配置 Access——判断只看 endpoint 是不是本机，不存在兼容模式。
 *
 * 分类原则（业务重试的判断权在 Cloudflare）：
 *   连不上 / 超时 / 408 / 425 / 429 / 5xx        → retryable（durable retry 会重试）
 *   401 / 403                                    → non-retryable：Access 凭据 / 策略错误
 *   400 / 404(提交) / 409 / 413 / 415 / 422       → non-retryable：请求本身不被接受
 *   404(轮询)                                    → 「服务不认识该请求」，返回 null 让 Workflow 决定重新提交
 */

const SUBMIT_TIMEOUT_MS = 20_000;
const CANCEL_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 8_000;
const POLL_SLACK_MS = 15_000;
const MAX_ERROR_BODY = 512;
/** 状态快照现在是纯元数据，响应体应该很小（正文走 /result）。 */
const MAX_SNAPSHOT_BYTES = 64 * 1024;

export function serviceBase(env: Env): string {
  const base = (env.TRANSCRIPTION_SERVICE_URL ?? "").trim().replace(/\/+$/, "");
  if (!base || !/^https?:\/\//i.test(base)) {
    throw new TranscriptionServiceError("unconfigured", "transcription_service_unconfigured", "TRANSCRIPTION_SERVICE_URL is not configured", false);
  }
  return base;
}

/** 本地开发：endpoint 直接指向本机（不需要 Access，也没有 Tunnel）。 */
export function isLocalServiceEndpoint(base: string): boolean {
  let host: string;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]" || host.endsWith(".localhost");
}

/**
 * 出站请求头：accept / content-type + Cloudflare Access service token。
 * 生产路径（非本机 endpoint）缺 Access 凭据 = 配置错误，直接以 unconfigured 失败，不做静默降级。
 */
export function serviceHeaders(env: Env, json = false): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (json) headers.set("content-type", "application/json");

  const clientId = (env.CF_ACCESS_CLIENT_ID ?? "").trim();
  const clientSecret = (env.CF_ACCESS_CLIENT_SECRET ?? "").trim();
  if (clientId && clientSecret) {
    headers.set("cf-access-client-id", clientId);
    headers.set("cf-access-client-secret", clientSecret);
    return headers;
  }
  if (isLocalServiceEndpoint(serviceBase(env))) return headers;
  throw new TranscriptionServiceError(
    "unconfigured",
    "transcription_service_unconfigured",
    "CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are not configured",
    false,
  );
}

function classifyHttp(status: number, body: string, retryAfter: string | null): TranscriptionServiceError {
  const detail = body.slice(0, MAX_ERROR_BODY);
  const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
  if (status === 401 || status === 403) {
    return new TranscriptionServiceError("http", "transcription_service_auth", `cloudflare access rejected the request (HTTP ${status})`, false, status);
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new TranscriptionServiceError("http", "transcription_service_unavailable", `transcription service HTTP ${status}: ${detail}`, true, status, retryAfterSeconds);
  }
  return new TranscriptionServiceError("http", "transcription_request_rejected", `transcription service rejected the request (HTTP ${status}): ${detail}`, false, status);
}

function classifyTransport(error: unknown): TranscriptionServiceError {
  if (error instanceof TranscriptionServiceError) return error;
  const name = (error as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new TranscriptionServiceError("timeout", "transcription_service_unavailable", "transcription service request timed out", true);
  }
  return new TranscriptionServiceError("unreachable", "transcription_service_unavailable", "transcription service is unreachable", true);
}

async function request(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (error) {
    throw classifyTransport(error);
  }
}

function readBounded(response: Response, maxBytes: number): Promise<string> {
  return readBoundedText(response, maxBytes, () =>
    new TranscriptionServiceError("protocol", "transcription_response_too_large", `response exceeds ${maxBytes} bytes`, false));
}

const STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled"]);

/** 解析并校验快照：request_id / provider_request_id 必须与调用方期望一致（stale / 串线防护）。 */
export function parseSnapshot(text: string, expected: { requestId: string; providerRequestId?: string }): TranscriptionSnapshot {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new TranscriptionServiceError("protocol", "transcription_protocol_error", "transcription service returned invalid JSON", false);
  }
  const snapshot = data as Partial<TranscriptionSnapshot> | null;
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.status !== "string" || !STATUSES.has(snapshot.status)) {
    throw new TranscriptionServiceError("protocol", "transcription_protocol_error", "transcription service returned an unrecognised snapshot", false);
  }
  if (snapshot.request_id !== expected.requestId) {
    throw new TranscriptionServiceError("protocol", "transcription_protocol_error", "response belongs to a different request_id", false);
  }
  if (typeof snapshot.provider_request_id !== "string" || !snapshot.provider_request_id) {
    throw new TranscriptionServiceError("protocol", "transcription_protocol_error", "response is missing provider_request_id", false);
  }
  if (expected.providerRequestId && snapshot.provider_request_id !== expected.providerRequestId) {
    throw new TranscriptionServiceError("protocol", "transcription_protocol_error", "response belongs to a different provider request", false);
  }
  if (snapshot.status === "completed") {
    const result = snapshot.result as unknown;
    const meta = result as { language?: unknown; duration?: unknown } | null;
    if (!meta || typeof meta !== "object" || typeof meta.language !== "string" || !Number.isFinite(meta.duration)) {
      throw new TranscriptionServiceError("protocol", "transcription_protocol_error", "completed snapshot has no result metadata", false);
    }
  }
  return snapshot as TranscriptionSnapshot;
}

/** 提交（以 request_id 幂等）。同一请求重复提交返回同一个 provider_request_id。 */
export async function submitTranscription(env: Env, body: TranscriptionRequestBody, fetchFn: typeof fetch = fetch): Promise<TranscriptionSnapshot> {
  if (transcriptionProvider(env) === "dashscope") {
    return submitDashscopeTranscription(env, body.request_id, body.source, body.options, fetchFn);
  }
  const base = serviceBase(env);
  const response = await request(fetchFn, `${base}${TRANSCRIPTIONS_PATH}`, {
    method: "POST",
    headers: serviceHeaders(env, true),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  const text = await readBounded(response, MAX_SNAPSHOT_BYTES).catch(error => {
    throw classifyTransport(error);
  });
  if (!response.ok) throw classifyHttp(response.status, text, response.headers.get("retry-after"));
  return parseSnapshot(text, { requestId: body.request_id });
}

/**
 * 长轮询一次。`waitSeconds` 让服务端在有变化前挂起（服务侧上限低于代理的空闲超时）。
 * 服务不认识该请求（404：重启 / 已回收）→ 返回 null，由 Workflow 决定重新提交。
 *
 * 返回的是**元数据快照**，不含 raw transcript 正文——因此一次 3 小时任务的上百次轮询总传输量
 * 与正文大小无关。
 */
export async function pollTranscription(
  env: Env,
  ref: { requestId: string; providerRequestId: string },
  waitSeconds: number,
  fetchFn: typeof fetch = fetch,
): Promise<TranscriptionSnapshot | null> {
  if (transcriptionProvider(env) === "dashscope") {
    return pollDashscopeTranscription(env, ref, waitSeconds, fetchFn);
  }
  const base = serviceBase(env);
  const wait = Math.max(0, Math.min(50, Math.trunc(waitSeconds)));
  const response = await request(fetchFn, `${base}${TRANSCRIPTIONS_PATH}/${encodeURIComponent(ref.providerRequestId)}?wait=${wait}`, {
    method: "GET",
    headers: serviceHeaders(env),
    signal: AbortSignal.timeout(wait * 1000 + POLL_SLACK_MS),
  });
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const text = await readBounded(response, MAX_SNAPSHOT_BYTES).catch(error => {
    throw classifyTransport(error);
  });
  if (!response.ok) throw classifyHttp(response.status, text, response.headers.get("retry-after"));
  return parseSnapshot(text, { requestId: ref.requestId, providerRequestId: ref.providerRequestId });
}

/**
 * 取回原始转录正文（已完成的请求才有）。**整个流水线只会调用它一次**——由 `persist-raw-N` step 调用，
 * 读完立刻写 R2。
 *
 * 返回 null = 服务不认识该请求（404：进程重启 / 结果已回收），由 Workflow 决定重新提交。
 * 有界读取：超过 `MAX_RAW_BYTES` 立刻中断并抛 `transcription_response_too_large`（non-retryable）。
 */
export async function fetchTranscriptionResult(
  env: Env,
  ref: { requestId: string; providerRequestId: string },
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  if (transcriptionProvider(env) === "dashscope") {
    return fetchDashscopeTranscriptionResult(env, ref, fetchFn);
  }
  const base = serviceBase(env);
  const response = await request(fetchFn, `${base}${TRANSCRIPTIONS_PATH}/${encodeURIComponent(ref.providerRequestId)}${TRANSCRIPTION_RESULT_SUFFIX}`, {
    method: "GET",
    headers: serviceHeaders(env),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const text = await readBounded(response, MAX_RAW_BYTES).catch(error => {
    throw classifyTransport(error);
  });
  if (!response.ok) throw classifyHttp(response.status, text, response.headers.get("retry-after"));
  return text;
}

/** 尽力取消 / 释放。任何失败都吞掉：responder 是否及时响应不影响 Cloudflare 任务的最终状态。 */
export async function cancelTranscription(env: Env, providerRequestId: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    if (transcriptionProvider(env) === "dashscope") return await cancelDashscopeTranscription();
    const base = serviceBase(env);
    const response = await fetchFn(`${base}${TRANSCRIPTIONS_PATH}/${encodeURIComponent(providerRequestId)}`, {
      method: "DELETE",
      headers: serviceHeaders(env),
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

export interface ServiceHealth {
  ok: boolean;
  detail: string;
  latencyMs?: number;
  engine?: string;
  activeRequests?: number;
}

/**
 * 供 Settings 探针使用：`GET /health`——唯一的健康端点。
 *
 * reference production path 上它是一个**经 Cloudflare Access 保护**的请求：返回 200 同时证明
 * Access 凭据、Tunnel 与 Transcription Service 三者都正常；401 / 403 说明 Access 拒绝了请求
 * （`transcription_service_auth`），缺 Access 凭据则是 unconfigured。
 * （探针不创建任何真实 transcription request。）
 */
export async function checkServiceHealth(env: Env, fetchFn: typeof fetch = fetch): Promise<ServiceHealth> {
  let provider: TranscriptionProvider;
  try {
    provider = transcriptionProvider(env);
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
  if (provider === "dashscope") {
    // 配置型探针：不实际调用服务商（避免计费副作用），只验证密钥已注入。
    if ((env.DASHSCOPE_API_KEY ?? "").trim()) {
      return { ok: true, detail: "百炼云端转录已配置（探针不实际调用服务商）", engine: "dashscope-paraformer" };
    }
    return { ok: false, detail: "未配置 DASHSCOPE_API_KEY，请运行 npx wrangler secret put DASHSCOPE_API_KEY" };
  }
  let base: string;
  try {
    base = serviceBase(env);
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
  const started = Date.now();
  try {
    const response = await fetchFn(`${base}${HEALTH_PATH}`, { method: "GET", headers: serviceHeaders(env), signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const latencyMs = Date.now() - started;
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: "Cloudflare Access 拒绝了请求，请检查 CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET 与 Access 策略", latencyMs };
    }
    if (!response.ok) return { ok: false, detail: `转录服务返回 HTTP ${response.status}`, latencyMs };
    const data = (await response.json().catch(() => ({}))) as { engine?: string; active_requests?: number };
    return { ok: true, detail: `转录服务连接正常（${latencyMs}ms）`, latencyMs, engine: data.engine, activeRequests: data.active_requests };
  } catch (error) {
    const reason = error instanceof TranscriptionServiceError ? error.message : "无法连接转录服务";
    return { ok: false, detail: reason };
  }
}
