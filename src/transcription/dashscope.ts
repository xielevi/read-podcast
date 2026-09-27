/**
 * 云端转录适配器（首个云端实现）：阿里云百炼 Paraformer 录音文件识别（异步任务型）。
 *
 * 这不是又一个对外协议实现，而是 Worker 内部的**协议翻译层**：把 Transcription Service 的
 * 中性契约（submit / poll / fetch / cancel，见 contract.ts）翻译成百炼的 REST 调用。
 * Workflow 的 step 结构（resolve-source → submit → poll → persist → release）完全不变，
 * 转录服务协议仍然是 Cloudflare 对外的中立协议——本文件只被 src/transcription/client.ts
 * 按 `TRANSCRIPTION_PROVIDER=dashscope` 分发调用。
 *
 * 与自托管服务的两点诚实差异（见 docs/ARCHITECTURE.md「云端转录适配器」）：
 *
 * 1. **提交不幂等**：百炼没有 request_id 幂等键。Workflow 的 durable step checkpoint 保证
 *    replay / 重试路径绝不重新执行已完成的提交；唯一的例外是「提交已被服务端接收但响应在
 *    返回途中丢失」，此时 durable retry 会创建第二个任务——旧任务成为孤儿（跑完即被 24 小时
 *    结果有效期回收，不污染任何业务状态，但消耗一次额度）。自托管路径以 request_id 幂等。
 * 2. **没有取消 API**：录音文件识别任务无法撤销。`cancel` 恒为不操作（返回 false），
 *    Workflow 的 release / 超时取消是尽力而为语义，不受影响。
 *
 * 音频流向（不经过 Worker）：
 *
 *     RSS:      Cloudflare ──跟随跳转后的最终公网 URL──▶ 百炼 ──▶ 播客 CDN
 *     Upload:   Cloudflare ──R2 presigned GET（2 小时有效）──▶ 百炼 ──▶ R2 (S3 endpoint)
 *
 * 百炼 API 事实（2026-09 官方文档核对）：
 *   - 提交：POST /api/v1/services/audio/asr/transcription，必须带 `X-DashScope-Async: enable`；
 *     单次请求只传 1 个 file_url；文件 ≤ 2 GB、最长 12 小时音频。
 *   - 查询：GET /api/v1/tasks/{task_id}；任务状态 PENDING / RUNNING / SUCCEEDED / FAILED。
 *   - 结果：SUCCEEDED 响应里给出 results[0].transcription_url（OSS 签名 URL，**24 小时有效**），
 *     下载得到 JSON（transcripts[].text / sentences[].text + properties 原始时长），解析出纯文本。
 *   - 无服务端进度百分比、无长轮询、无取消：轮询节奏由客户端等待（waitSeconds）承担。
 */
import { readBoundedText } from "../net/bounded";
import { TranscriptionServiceError, type TranscriptionOptions, type TranscriptionSnapshot } from "./contract";
import type { Env } from "../types";

/** 默认地域端点；workspace 专属域名上线后旧域名保持可用，不引入部署变量。 */
export const DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const TRANSCRIPTION_SUBMIT_PATH = "/services/audio/asr/transcription";
const TASKS_PATH = "/tasks";
/** 首个云端实现固定为 paraformer-v2（中英混合；language_hints 仅此模型支持）。 */
const PARAFORMER_MODEL = "paraformer-v2";
/** workerd 的 fetch 支持的鉴权方式只有 header；百炼 API Key 走标准 Bearer。 */
const API_KEY_ENV = "DASHSCOPE_API_KEY";

const SUBMIT_TIMEOUT_MS = 20_000;
const QUERY_TIMEOUT_MS = 20_000;
const RESULT_TIMEOUT_MS = 60_000;
/**
 * 结果 JSON 的读取上限（原始正文远小于此；大头是词级时间戳数组——
 * 12 小时音频 ≈ 8 MiB，16 MiB 留出 2 倍余量，同时防止异常响应撑爆 Worker 内存）。
 */
const MAX_RESULT_JSON_BYTES = 16 * 1024 * 1024;
/** 快照响应体极小（状态 + results 元数据）；异常大的响应按协议错误拒收。 */
const MAX_QUERY_RESPONSE_BYTES = 256 * 1024;
/** 百炼不支持长轮询：waitSeconds 的语义退化为「仍在运行时客户端等待再返回」。 */
const MAX_CLIENT_WAIT_SECONDS = 50;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 云端任务失败 → 契约 error.code。取不到音频 / 额度用尽是确定性失败，重试不会改变结论。 */
export function providerCodeForDashscopeFailure(code: string, message: string): string {
  const combined = `${code} ${message}`;
  if (/download|invalid[\s_-]?file|unsupported[\s_-]?format|media/i.test(combined)) return "provider_fetch_failed";
  if (/quota|allocation|limit[_-]?exceeded|exhausted|arrear|欠费|额度/i.test(combined)) return "provider_quota_exhausted";
  return "transcription_failed";
}

function dashscopeHeaders(env: Env, json = false): Headers {
  const apiKey = (env.DASHSCOPE_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new TranscriptionServiceError(
      "unconfigured",
      "transcription_service_unconfigured",
      "DASHSCOPE_API_KEY is not configured (npx wrangler secret put DASHSCOPE_API_KEY)",
      false,
    );
  }
  const headers = new Headers({ authorization: `Bearer ${apiKey}` });
  if (json) headers.set("content-type", "application/json");
  return headers;
}

function classifyHttp(status: number, body: string): TranscriptionServiceError {
  const detail = body.slice(0, 512);
  if (status === 401 || status === 403) {
    return new TranscriptionServiceError("http", "transcription_service_auth", `百炼拒绝了请求（HTTP ${status}）：API Key 无效或无权限`, false, status);
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new TranscriptionServiceError("http", "transcription_service_unavailable", `百炼服务 HTTP ${status}: ${detail}`, true, status);
  }
  return new TranscriptionServiceError("http", "transcription_request_rejected", `百炼拒绝了该请求（HTTP ${status}）: ${detail}`, false, status);
}

function classifyTransport(error: unknown): TranscriptionServiceError {
  if (error instanceof TranscriptionServiceError) return error;
  const name = (error as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new TranscriptionServiceError("timeout", "transcription_service_unavailable", "百炼服务请求超时", true);
  }
  return new TranscriptionServiceError("unreachable", "transcription_service_unavailable", "百炼服务不可达", true);
}

async function requestJson(fetchFn: typeof fetch, url: string, init: RequestInit, maxBytes: number): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch (error) {
    throw classifyTransport(error);
  }
  let text: string;
  try {
    text = await readBoundedText(response, maxBytes, () =>
      new TranscriptionServiceError("protocol", "transcription_response_too_large", `响应超过 ${maxBytes} 字节上限`, false));
  } catch (error) {
    throw classifyTransport(error);
  }
  if (!response.ok) throw classifyHttp(response.status, text);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new TranscriptionServiceError("protocol", "transcription_protocol_error", "百炼返回了无法解析的 JSON", false);
  }
  if (!data || typeof data !== "object") {
    throw new TranscriptionServiceError("protocol", "transcription_protocol_error", "百炼响应不是 JSON 对象", false);
  }
  return data as Record<string, unknown>;
}

function outputOf(data: Record<string, unknown>): Record<string, unknown> {
  const output = data.output as Record<string, unknown> | null;
  if (!output || typeof output !== "object" || typeof output.task_status !== "string") {
    throw new TranscriptionServiceError("protocol", "transcription_protocol_error", "百炼响应缺少 output.task_status", false);
  }
  return output;
}

const DASHSCOPE_STATUS: Record<string, TranscriptionSnapshot["status"]> = {
  PENDING: "queued",
  RUNNING: "running",
  SUCCEEDED: "completed",
  FAILED: "failed",
};

/**
 * 把一次百炼查询响应翻译成契约快照。
 *
 * 契约的 completed 快照要求 result 元数据（language / duration），但百炼的查询响应不含这些——
 * 它们在结果文件里，由 persist 阶段的 fetchResult 单独读取。快照的 result 留空：Workflow 的
 * 业务判断只消费 status，正文与元数据各走各的路径（与自托管协议「正文与状态分开」同一取舍）。
 */
/**
 * 单文件子任务的失败详情。百炼的 task_status 是批任务级状态：文件下载失败时可能仍报 SUCCEEDED，
 * 真正的失败原因（如 InvalidFile.DownloadFailed）在 results[0].subtask_status / code / message 里。
 */
function failedSubtask(output: Record<string, unknown>): { code: string; message: string } | null {
  const first = (Array.isArray(output.results) ? output.results[0] : undefined) as Record<string, unknown> | undefined;
  if (!first || first.subtask_status !== "FAILED") return null;
  return {
    code: typeof first.code === "string" ? first.code : "",
    message: typeof first.message === "string" ? first.message : "",
  };
}

function snapshotFromDashscope(requestId: string, taskId: string, output: Record<string, unknown>): TranscriptionSnapshot {
  const dashscopeStatus = output.task_status as string;
  let status = DASHSCOPE_STATUS[dashscopeStatus];
  if (!status) {
    throw new TranscriptionServiceError("protocol", "transcription_protocol_error", `百炼返回未知任务状态 ${dashscopeStatus}`, false);
  }
  const subtask = status === "completed" ? failedSubtask(output) : null;
  if (subtask) status = "failed";
  const snapshot: TranscriptionSnapshot = { request_id: requestId, provider_request_id: taskId, status };
  if (status === "failed") {
    const code = subtask ? subtask.code : typeof output.code === "string" ? output.code : "";
    const message = subtask ? subtask.message : typeof output.message === "string" ? output.message : "";
    snapshot.error = { code: providerCodeForDashscopeFailure(code, message), message: message || code || dashscopeStatus };
  }
  if (status === "running") snapshot.progress = { phase: "transcribing", percent: 0 };
  return snapshot;
}

/**
 * 提交一次录音文件识别。`requestId` 是 Cloudflare 的幂等键（task:attempt），但百炼没有对应的
 * 幂等语义——它只用于把返回快照与本次请求绑定。provider_request_id = 百炼 task_id。
 */
export async function submitDashscopeTranscription(
  env: Env,
  requestId: string,
  source: { type: string; url: string },
  options: TranscriptionOptions | undefined,
  fetchFn: typeof fetch,
): Promise<TranscriptionSnapshot> {
  const body: Record<string, unknown> = {
    model: PARAFORMER_MODEL,
    input: { file_urls: [source.url] },
  };
  const language = options?.language?.trim();
  if (language) body.parameters = { language_hints: [language] };

  const headers = dashscopeHeaders(env, true);
  // 百炼要求显式声明异步提交，否则任务无法创建
  headers.set("X-DashScope-Async", "enable");
  const data = await requestJson(fetchFn, `${DASHSCOPE_BASE_URL}${TRANSCRIPTION_SUBMIT_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  }, MAX_QUERY_RESPONSE_BYTES);
  const output = outputOf(data);
  const taskId = typeof output.task_id === "string" ? output.task_id : "";
  if (!taskId) {
    throw new TranscriptionServiceError("protocol", "transcription_protocol_error", "百炼提交响应缺少 task_id", false);
  }
  return snapshotFromDashscope(requestId, taskId, output);
}

/** 查询一次任务状态。waitSeconds 在百炼退化为客户端等待（仅当任务仍在进行时）。 */
export async function pollDashscopeTranscription(
  env: Env,
  ref: { requestId: string; providerRequestId: string },
  waitSeconds: number,
  fetchFn: typeof fetch,
): Promise<TranscriptionSnapshot | null> {
  const data = await requestJson(
    fetchFn,
    `${DASHSCOPE_BASE_URL}${TASKS_PATH}/${encodeURIComponent(ref.providerRequestId)}`,
    { method: "GET", headers: dashscopeHeaders(env), signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) },
    MAX_QUERY_RESPONSE_BYTES,
  ).catch((error: unknown) => {
    if (error instanceof TranscriptionServiceError && error.status === 404) return null;
    throw error;
  });
  if (!data) return null; // 服务不认识该任务 → 交给 Workflow 重新提交
  const output = outputOf(data);
  const status = output.task_status as string;
  const snapshot = snapshotFromDashscope(ref.requestId, ref.providerRequestId, output);
  // 服务端不支持长轮询：仍要进行中的任务时由客户端等待，避免密集空转。
  if ((status === "PENDING" || status === "RUNNING") && waitSeconds > 0) {
    await sleep(Math.min(MAX_CLIENT_WAIT_SECONDS, Math.max(0, Math.trunc(waitSeconds))) * 1000);
  }
  return snapshot;
}

/** 结果文件（transcription_url 指向的 JSON）里我们消费的最小形状。 */
interface DashscopeResultFile {
  properties?: { original_duration_in_milliseconds?: unknown };
  transcripts?: Array<{ text?: unknown; sentences?: Array<{ text?: unknown }> | null }>;
}

/**
 * 取回原始转录正文：查询任务 → 拿 transcription_url（24 小时有效）→ 下载结果 JSON → 提取纯文本。
 * 词级时间戳、句子级切片等富信息全部丢弃——Cloudflare 只需要 raw 正文（与自托管的 /result 同语义）。
 */
export async function fetchDashscopeTranscriptionResult(
  env: Env,
  ref: { requestId: string; providerRequestId: string },
  fetchFn: typeof fetch,
): Promise<string | null> {
  const data = await requestJson(
    fetchFn,
    `${DASHSCOPE_BASE_URL}${TASKS_PATH}/${encodeURIComponent(ref.providerRequestId)}`,
    { method: "GET", headers: dashscopeHeaders(env), signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) },
    MAX_QUERY_RESPONSE_BYTES,
  ).catch((error: unknown) => {
    if (error instanceof TranscriptionServiceError && error.status === 404) return null;
    throw error;
  });
  if (!data) return null;
  const output = outputOf(data);
  if (output.task_status === "FAILED") return null; // 查询时刻已是失败 → 交给 Workflow 重新提交
  if (output.task_status !== "SUCCEEDED" || failedSubtask(output)) return null;
  const results = Array.isArray(output.results) ? output.results : [];
  const first = results[0] as { transcription_url?: unknown; subtask_status?: unknown } | undefined;
  if (!first || typeof first.transcription_url !== "string" || !first.transcription_url) {
    throw new TranscriptionServiceError("protocol", "transcription_protocol_error", "百炼成功响应缺少 results[0].transcription_url", false);
  }

  const resultJson = await requestJson(
    fetchFn,
    first.transcription_url,
    { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(RESULT_TIMEOUT_MS) },
    MAX_RESULT_JSON_BYTES,
  );
  const file = resultJson as unknown as DashscopeResultFile;
  const transcripts = Array.isArray(file.transcripts) ? file.transcripts : [];
  const text = transcripts
    .map(transcript => {
      if (typeof transcript?.text === "string" && transcript.text.trim()) return transcript.text;
      const sentences = Array.isArray(transcript?.sentences) ? transcript.sentences : [];
      return sentences.map(sentence => (typeof sentence?.text === "string" ? sentence.text : "")).join("");
    })
    .filter(paragraph => paragraph.trim())
    .join("\n\n");
  return text;
}

/** 尽力释放：百炼没有取消任务或释放资源的 API，这里无事可做。 */
export async function cancelDashscopeTranscription(): Promise<boolean> {
  return false;
}
