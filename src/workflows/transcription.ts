/**
 * Processing Workflow 的转录阶段：Cloudflare 驱动一次外部转录计算，直到 raw 落 R2。
 *
 * 步骤（每个都是 durable step——已完成的 step 在 replay / retry 时不会重新执行）：
 *
 *   resolve-raw                      R2 已有可信 raw？有 → 直接返回，绝不重新转录
 *   start-transcription              D1 CAS：queued → transcribing
 *   ┌ resolve-source-N               解析 source descriptor（RSS → 公网 URL；上传 → R2 presigned GET）
 *   │ submit-transcription-N         向转录服务提交（以 request_id 幂等），记下 provider_request_id
 *   │ poll-transcription-N-k …       长轮询 + 进度映射；每个 step 一个 ~4 分钟窗口
 *   │ persist-raw-N                  取回结果 → 校验 → 写 R2 → D1 CAS 记下 raw_object_key
 *   └ release-transcription-N        尽力通知服务释放资源（失败不影响任何结论）
 *   （提交失败 / 服务丢失请求 / 超时 → 下一次提交，最多 MAX_SUBMISSIONS 次）
 *
 * **source 的生命周期对应 submission，不对应 HTTP attempt**（这是 `resolve-source-N` 存在的唯一原因）：
 * 上传音频的 presigned URL 含时间戳与签名，每次生成都不同；转录服务对 `request_id` 做幂等并要求
 * 同一个 request_id 的 `source_url` 一致。如果每次 submit retry 都重新生成 URL，就会出现
 *
 *     第一次 POST 已被服务接收 → Cloudflare 没收到 response（timeout / transport error）
 *       → durable retry → 新的 presigned URL → same request_id + different URL → 409 request_conflict
 *
 * 把「解析 source」做成 durable step 之后，同一 submission 内 URL 是 checkpoint 里的同一个值，
 * 无论 submit 重试多少次都完全一致；只有当整个 submission 被判定失败（provider 真丢了请求 / 超时）
 * 才会进入 submission-2 并重新解析（那时 URL 不同是正确且必要的）。
 *
 * 业务判断全部在这里（Cloudflare）：
 *   - 服务连不上 / 超时 / 5xx / 429 → retryable：由 Workflow 的 durable retry（指数退避，容忍数小时故障）；
 *   - 鉴权 / 配置 / 请求被拒 → NonRetryable：立即失败并给出可行动的原因；
 *   - 服务丢了请求（重启 / 回收）→ 重新提交（受次数上限约束）；
 *   - 结果晚到 / 重复 → 以 (task, attempt, provider_request_id) 校验，stale 一律拒绝，重复写入幂等。
 * 转录服务只报告事实（状态、进度、error.code），从不决定「要不要重试」。
 */
import { mapGlobalProgress } from "../progress";
import { MIN_REAL_TRANSCRIPT_CHARS } from "../refinement/defaults";
import { rawObjectKey, resolveExistingRawKey } from "../raw";
import {
  NON_RETRYABLE_PROVIDER_ERRORS,
  TranscriptionServiceError,
  taskErrorCodeForProvider,
  transcriptionRequestId,
  type ProviderPhase,
  type TranscriptionSnapshot,
} from "../transcription/contract";
import { cancelTranscription, fetchTranscriptionResult, pollTranscription, submitTranscription } from "../transcription/client";
import { SourceError, resolveTranscriptionSource, uploadIdFromAudioUrl } from "../transcription/source";
import { deleteUploadObjects } from "../uploads";
import type { Env, TranscriptionPhase } from "../types";
import type { TranscriptionSource } from "../transcription/contract";
import { NOW, loadTaskRow } from "../db";
import {
  assertTaskOwned,
  exponentialRetryDelay,
  nonRetryable,
  workflowError,
  type ProcessingWorkflowParams,
  type StepContextLike,
  type WorkflowStepLike,
} from "./common";

export const RESOLVE_RAW_STEP = "resolve-raw";
export const START_TRANSCRIPTION_STEP = "start-transcription";
export const resolveSourceStepName = (submission: number) => `resolve-source-${submission}`;
export const submitStepName = (submission: number) => `submit-transcription-${submission}`;
export const pollStepName = (submission: number, poll: number) => `poll-transcription-${submission}-${poll}`;
export const persistStepName = (submission: number) => `persist-raw-${submission}`;
export const releaseStepName = (submission: number) => `release-transcription-${submission}`;
export const backoffStepName = (submission: number) => `resubmit-backoff-${submission}`;

/** 同一 attempt 内最多向转录服务提交几次（服务丢请求 / 可重试的失败 / 超时都会消耗一次）。 */
export const MAX_SUBMISSIONS = 3;
/**
 * 服务不可达时 durable retry 的次数上限：指数退避封顶 5 分钟 → 约 4 小时的故障容忍窗口；
 * 服务在窗口内恢复，任务自动继续；超出则任务转 error，用户可一键重试（raw 已存在则不重转）。
 */
export const SUBMIT_RETRY_LIMIT = 48;
export const POLL_RETRY_LIMIT = 48;
export const PERSIST_RETRY_LIMIT = 8;
/** 解析 source（R2 读取对象元数据 + 本地签名）失败的 durable retry 次数。 */
export const SOURCE_RETRY_LIMIT = 5;

/** 单个 poll step 的时间窗口与 subrequest 预算（Free 计划每次调用 50 个 subrequest）。 */
export const POLL_WINDOW_MS = 4 * 60_000;
export const POLL_STEP_TIMEOUT = "6 minutes";
export const POLL_WAIT_SECONDS = 25;
export const POLL_MIN_INTERVAL_MS = 5_000;
export const MAX_POLLS_PER_STEP = 14;
/** 单次提交的最长等待（含排队）：超出视为服务端卡死，取消并重新提交。 */
export const MAX_TRANSCRIPTION_MS = 8 * 60 * 60_000;
export const RESUBMIT_BACKOFF = "30 seconds";

type StepRunner = WorkflowStepLike;
type Fetch = typeof fetch;

// ── 进度映射（转录服务上报子阶段，Cloudflare 决定全局进度与用户可见文案） ──

interface MappedProgress {
  progress: number;
  message: string;
  phase: TranscriptionPhase | null;
}

export function mapProviderProgress(snapshot: TranscriptionSnapshot): MappedProgress {
  const phase: ProviderPhase = snapshot.progress?.phase ?? "queued";
  const percent = Math.max(0, Math.min(100, Number(snapshot.progress?.percent ?? 0)));
  const detail = (snapshot.progress?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  switch (phase) {
    case "fetching":
      return { progress: mapGlobalProgress("downloading", percent), message: "正在获取音频…", phase: "fetching" };
    case "preparing":
      return { progress: mapGlobalProgress("downloading", 100), message: "正在准备音频…", phase: "preparing" };
    case "transcribing":
      return {
        progress: mapGlobalProgress("transcribing", percent),
        message: detail ? `语音转录中 ${percent}% · ${detail}` : `语音转录中 ${percent}%`,
        phase: "transcribing",
      };
    default:
      return { progress: 0, message: "转录服务排队中…", phase: null };
  }
}

// ── D1 写入（全部带 attempt / 取消 / 成稿边界守卫；0 changes 表示任务已不归本 attempt） ──

const OWNED_TRANSCRIBING = `id = ? AND current_attempt_id = ? AND cancel_requested = 0 AND status = 'transcribing'`;

async function applyProgress(env: Env, params: ProcessingWorkflowParams, mapped: MappedProgress): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE tasks
    SET progress = MAX(progress, ?), message = ?, transcription_phase = ?, updated_at = ${NOW}
    WHERE ${OWNED_TRANSCRIBING}`)
    .bind(mapped.progress, mapped.message, mapped.phase, params.taskId, params.attemptId)
    .run();
  return Boolean(result.meta.changes);
}

async function recordMessage(env: Env, params: ProcessingWorkflowParams, message: string): Promise<void> {
  await env.DB.prepare(`UPDATE tasks SET message = ?, updated_at = ${NOW} WHERE ${OWNED_TRANSCRIBING}`)
    .bind(message, params.taskId, params.attemptId)
    .run()
    .catch(() => undefined);
}

/** 0 changes 之后的统一判定：取消 / 过期 attempt / 终态 → NonRetryable；其余是毫秒级竞态 → 允许重试。 */
async function explainInactive(env: Env, params: ProcessingWorkflowParams, context: string): Promise<never> {
  assertTaskOwned(await loadTaskRow(env, params.taskId), params.attemptId);
  throw new Error(`${context}: task state changed concurrently`);
}

// ── resolve-raw ──

export interface ResolvedRaw {
  rawKey: string | null;
}

export async function resolveRawStep(env: Env, params: ProcessingWorkflowParams): Promise<ResolvedRaw> {
  const task = assertTaskOwned(await loadTaskRow(env, params.taskId), params.attemptId);
  const existing = await resolveExistingRawKey(env, task.id, task.raw_object_key);
  if (!existing) return { rawKey: null };

  // 采纳已有 raw：记录 raw_object_key，随后 claim-refinement 直接进入精修（不联系转录服务）。
  const adopted = await env.DB.prepare(`UPDATE tasks
    SET raw_object_key = ?, message = '已有原始转录，直接进入精修', updated_at = ${NOW}
    WHERE id = ? AND current_attempt_id = ? AND cancel_requested = 0
      AND status IN ('queued', 'transcribing')`)
    .bind(existing, params.taskId, params.attemptId)
    .run();
  if (!adopted.meta.changes) await explainInactive(env, params, "resolve_raw");
  return { rawKey: existing };
}

// ── start-transcription ──

export async function startTranscriptionStep(env: Env, params: ProcessingWorkflowParams): Promise<void> {
  const result = await env.DB.prepare(`UPDATE tasks
    SET status = 'transcribing', message = '正在准备音频…', transcription_phase = NULL, updated_at = ${NOW}
    WHERE id = ? AND current_attempt_id = ? AND cancel_requested = 0
      AND status IN ('queued', 'transcribing')`)
    .bind(params.taskId, params.attemptId)
    .run();
  if (!result.meta.changes) await explainInactive(env, params, "start_transcription");
}

// ── resolve-source-N ──

/**
 * 解析本次 submission 的 source descriptor，并把它**固定在这一个 durable step 的结果里**。
 *
 * 结果必须是小而可序列化的纯数据（presigned URL + 体积上限），因为它是 Workflow 的 checkpoint。
 * 刻意不引入任何「已签名 URL 缓存表」：durable step 的结果就是那份缓存，而且它天然只属于这一个
 * submission，不会跨 submission 泄漏旧 URL。
 */
export async function resolveSourceStep(env: Env, params: ProcessingWorkflowParams): Promise<TranscriptionSource> {
  const task = assertTaskOwned(await loadTaskRow(env, params.taskId), params.attemptId);
  if (task.status !== "transcribing") throw new Error(`resolve_source: unexpected task status ${task.status}`);
  try {
    return await resolveTranscriptionSource(env, task);
  } catch (error) {
    throw toWorkflowError(error);
  }
}

// ── submit-transcription-N ──

export interface Submitted {
  providerRequestId: string;
}

function outageMessage(error: TranscriptionServiceError, attempt: number): string {
  if (error.kind === "timeout") return `转录服务响应超时，将自动重试（第 ${attempt} 次）`;
  return `转录服务暂不可用，将自动重试（第 ${attempt} 次）`;
}

/**
 * 失败路径上的所有权复核：任务已被取消 / attempt 已被替换 / 已终态时，不能再对一个不可达的转录服务
 * 无谓地 durable retry（可能长达数小时）——直接以 NonRetryable 收敛。正常路径不付出额外的 D1 读取。
 */
async function stopIfNoLongerOwned(env: Env, params: ProcessingWorkflowParams): Promise<void> {
  assertTaskOwned(await loadTaskRow(env, params.taskId), params.attemptId);
}

/** 把转录服务 / source 的错误统一翻译成 workflow 语义：可重试 → durable retry；否则 NonRetryable。 */
function toWorkflowError(error: unknown): Error {
  if (error instanceof TranscriptionServiceError) {
    return workflowError(error.code, error.message, { retryable: error.retryable, retryAfterSeconds: error.retryAfterSeconds });
  }
  if (error instanceof SourceError) return nonRetryable(error.code, error.message);
  return error as Error;
}

/**
 * 向转录服务提交。
 *
 * `source` 来自 `resolve-source-${submission}` 的 checkpoint，**不是每次调用重新构造的**：
 * 这个 step 的 durable retry 会反复执行同一个回调，但必须始终送出完全相同的 source URL，
 * 否则服务端会以 `409 request_conflict`（same request_id + different source_url）拒绝。
 */
export async function submitTranscriptionStep(
  env: Env,
  params: ProcessingWorkflowParams,
  ctx: StepContextLike,
  source: TranscriptionSource,
  fetchFn: Fetch,
): Promise<Submitted> {
  const task = assertTaskOwned(await loadTaskRow(env, params.taskId), params.attemptId);
  if (task.status !== "transcribing") throw new Error(`submit_transcription: unexpected task status ${task.status}`);
  const requestId = transcriptionRequestId(params.taskId, params.attemptId);

  let snapshot: TranscriptionSnapshot;
  try {
    const options: { language?: string } = {};
    if (env.TRANSCRIPTION_LANGUAGE) options.language = env.TRANSCRIPTION_LANGUAGE;
    snapshot = await submitTranscription(env, { request_id: requestId, source, ...(Object.keys(options).length ? { options } : {}) }, fetchFn);
  } catch (error) {
    if (error instanceof TranscriptionServiceError && error.retryable) {
      await stopIfNoLongerOwned(env, params);
      await recordMessage(env, params, outageMessage(error, ctx.attempt));
    }
    throw toWorkflowError(error);
  }

  const recorded = await env.DB.prepare(`UPDATE tasks
    SET provider_request_id = ?, message = '转录服务已接收，正在获取音频…', transcription_phase = 'fetching', updated_at = ${NOW}
    WHERE ${OWNED_TRANSCRIBING}`)
    .bind(snapshot.provider_request_id, params.taskId, params.attemptId)
    .run();
  if (!recorded.meta.changes) {
    // 提交成功的瞬间任务被取消 / attempt 被替换：不能留下无人认领的外部计算。
    await cancelTranscription(env, snapshot.provider_request_id, fetchFn);
    await explainInactive(env, params, "submit_transcription");
  }
  return { providerRequestId: snapshot.provider_request_id };
}

// ── poll-transcription-N-k ──

export type PollOutcome =
  | { state: "running"; waitedMs: number }
  | { state: "completed"; waitedMs: number }
  | { state: "lost"; waitedMs: number; reason: string }
  | { state: "failed"; waitedMs: number; code: string; message: string; retryable: boolean };

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface PollTuning {
  windowMs: number;
  maxPolls: number;
  waitSeconds: number;
  minIntervalMs: number;
  /** 单次提交的最长等待；缺省 MAX_TRANSCRIPTION_MS。测试可缩小以验证 provider 超时。 */
  maxTranscriptionMs?: number;
}

const DEFAULT_TUNING: PollTuning = {
  windowMs: POLL_WINDOW_MS,
  maxPolls: MAX_POLLS_PER_STEP,
  waitSeconds: POLL_WAIT_SECONDS,
  minIntervalMs: POLL_MIN_INTERVAL_MS,
};

export async function pollTranscriptionStep(
  env: Env,
  params: ProcessingWorkflowParams,
  submitted: Submitted,
  fetchFn: Fetch,
  tuning: PollTuning = DEFAULT_TUNING,
): Promise<PollOutcome> {
  const started = Date.now();
  const ref = { requestId: transcriptionRequestId(params.taskId, params.attemptId), providerRequestId: submitted.providerRequestId };

  for (let poll = 1; ; poll += 1) {
    const iterationStarted = Date.now();
    let snapshot: TranscriptionSnapshot | null;
    try {
      snapshot = await pollTranscription(env, ref, tuning.waitSeconds, fetchFn);
    } catch (error) {
      if (error instanceof TranscriptionServiceError && error.retryable) {
        await stopIfNoLongerOwned(env, params);
        await recordMessage(env, params, "转录服务暂不可达，正在等待恢复…");
      }
      throw toWorkflowError(error);
    }
    const waitedMs = Date.now() - started;
    if (!snapshot) return { state: "lost", waitedMs, reason: "unknown_request" };

    if (snapshot.status === "completed") return { state: "completed", waitedMs };
    if (snapshot.status === "cancelled") return { state: "lost", waitedMs, reason: "provider_cancelled" };
    if (snapshot.status === "failed") {
      const code = snapshot.error?.code || "transcription_failed";
      return {
        state: "failed",
        waitedMs,
        code,
        message: snapshot.error?.message ?? code,
        retryable: !NON_RETRYABLE_PROVIDER_ERRORS.has(code),
      };
    }

    // 进度镜像同时是心跳；0 changes = 取消 / 换 attempt → 立即停止，不再占用外部计算的等待。
    const applied = await applyProgress(env, params, mapProviderProgress(snapshot));
    if (!applied) await explainInactive(env, params, "poll_transcription");

    if (Date.now() - started >= tuning.windowMs || poll >= tuning.maxPolls) return { state: "running", waitedMs: Date.now() - started };
    // 服务端不支持长轮询（立即返回）时避免空转：保证最小轮询间隔。
    const elapsed = Date.now() - iterationStarted;
    if (elapsed < tuning.minIntervalMs) await sleep(tuning.minIntervalMs - elapsed);
  }
}

// ── persist-raw-N ──

export type PersistOutcome = { state: "persisted"; rawKey: string } | { state: "lost"; reason: string };

export async function persistRawStep(
  env: Env,
  params: ProcessingWorkflowParams,
  submitted: Submitted,
  fetchFn: Fetch,
): Promise<PersistOutcome> {
  const task = assertTaskOwned(await loadTaskRow(env, params.taskId), params.attemptId);
  // 迟到 / 串线的结果一律拒绝：只有当前 attempt 最近一次提交对应的 provider 请求才能成为 raw。
  if (task.provider_request_id !== submitted.providerRequestId) {
    throw nonRetryable("stale_provider_request", "Result belongs to a superseded transcription request");
  }

  const ref = { requestId: transcriptionRequestId(params.taskId, params.attemptId), providerRequestId: submitted.providerRequestId };
  let snapshot: TranscriptionSnapshot | null;
  try {
    // 先确认「确实是这次提交、确实已完成」——此时响应只有元数据，不搬正文。
    snapshot = await pollTranscription(env, ref, 0, fetchFn);
  } catch (error) {
    if (error instanceof TranscriptionServiceError && error.retryable) await stopIfNoLongerOwned(env, params);
    throw toWorkflowError(error);
  }
  if (!snapshot) return { state: "lost", reason: "result_unavailable" };
  if (snapshot.status !== "completed") return { state: "lost", reason: `status_${snapshot.status}` };

  // 正文只在这里取一次（有界读取；超过 MAX_RAW_BYTES 直接中断，归类为 raw_too_large）。
  let text: string | null;
  try {
    text = await fetchTranscriptionResult(env, ref, fetchFn);
  } catch (error) {
    if (error instanceof TranscriptionServiceError && error.code === "transcription_response_too_large") {
      throw nonRetryable("raw_too_large", "Raw transcript exceeds the storage limit");
    }
    if (error instanceof TranscriptionServiceError && error.retryable) await stopIfNoLongerOwned(env, params);
    throw toWorkflowError(error);
  }
  if (text === null) return { state: "lost", reason: "result_unavailable" };

  // raw 完整性护栏：真实播客转录不可能只有几十个有效字符。过短说明上游转录退化（例如占位模式），
  // 当场拒绝——不落 R2、不删除上传的原音频（Retry 需要它重新转录）。
  if (text.replace(/\s+/g, "").length < MIN_REAL_TRANSCRIPT_CHARS) {
    throw nonRetryable("transcription_invalid", "Raw transcript is implausibly short; transcription likely failed");
  }

  const key = rawObjectKey(params.taskId, params.attemptId);
  await env.RAW_BUCKET.put(key, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });

  // D1 CAS：只有仍处于本 attempt 转录阶段的 raw 才能成为交付凭证。同一 key 重复写入幂等通过。
  const stored = await env.DB.prepare(`UPDATE tasks
    SET raw_object_key = ?, transcription_phase = NULL, progress = MAX(progress, 64),
        message = '原始转录已保存，进入精修…', updated_at = ${NOW}
    WHERE ${OWNED_TRANSCRIBING} AND (raw_object_key IS NULL OR raw_object_key = ?)`)
    .bind(key, params.taskId, params.attemptId, key)
    .run();
  if (!stored.meta.changes) {
    const current = await loadTaskRow(env, params.taskId);
    // 落库前被取消 / 被替换：清掉刚写的（本 attempt 专属）对象，避免孤儿。
    if (!current || current.raw_object_key !== key) await env.RAW_BUCKET.delete(key).catch(() => undefined);
    await explainInactive(env, params, "persist_raw");
  }

  // 主动清理：仅 upload 任务，且必须在「raw 已验证可信 + 已持久化」之后才删除临时原音频。
  if (task.source_type === "upload") {
    await deleteUploadObjects(env, uploadIdFromAudioUrl(task.audio_url)).catch(() => undefined);
  }
  return { state: "persisted", rawKey: key };
}

// ── 阶段编排 ──

const SMALL_STEP = { retries: { limit: 3, delay: "5 seconds" }, timeout: "2 minutes" } as const;

function providerFailureError(outcome: Extract<PollOutcome, { state: "failed" }>): Error {
  return nonRetryable(taskErrorCodeForProvider(outcome.code), outcome.message);
}

/** 返回可供精修的 raw 的 R2 key。 */
export async function runTranscriptionPhase(
  env: Env,
  params: ProcessingWorkflowParams,
  _instanceId: string,
  step: StepRunner,
  fetchFn: Fetch = fetch,
  tuning: PollTuning = DEFAULT_TUNING,
): Promise<string> {
  const resolved = await step.do(RESOLVE_RAW_STEP, SMALL_STEP, async () => resolveRawStep(env, params));
  if (resolved.rawKey) return resolved.rawKey;

  await step.do(START_TRANSCRIPTION_STEP, SMALL_STEP, async () => startTranscriptionStep(env, params));

  let lastFailure: { code: string; message: string } = { code: "transcription_failed", message: "transcription did not complete" };

  for (let submission = 1; submission <= MAX_SUBMISSIONS; submission += 1) {
    // source 在 submit 之前解析，并且只解析一次：同一 submission 内的任何 submit retry 都复用
    // 这同一个 descriptor（见文件头注释）。submission-2 会重新解析出一个新的 URL。
    const source = await step.do(
      resolveSourceStepName(submission),
      { retries: { limit: SOURCE_RETRY_LIMIT, delay: exponentialRetryDelay }, timeout: "2 minutes" },
      async () => resolveSourceStep(env, params),
    );

    const submitted = await step.do(
      submitStepName(submission),
      { retries: { limit: SUBMIT_RETRY_LIMIT, delay: exponentialRetryDelay }, timeout: "3 minutes" },
      async ctx => submitTranscriptionStep(env, params, ctx, source, fetchFn),
    );

    let outcome: PollOutcome | { state: "timeout" };
    let waited = 0;
    for (let poll = 1; ; poll += 1) {
      const result = await step.do(
        pollStepName(submission, poll),
        { retries: { limit: POLL_RETRY_LIMIT, delay: exponentialRetryDelay }, timeout: POLL_STEP_TIMEOUT },
        async () => pollTranscriptionStep(env, params, submitted, fetchFn, tuning),
      );
      waited += result.waitedMs;
      if (result.state !== "running") {
        outcome = result;
        break;
      }
      if (waited > (tuning.maxTranscriptionMs ?? MAX_TRANSCRIPTION_MS)) {
        outcome = { state: "timeout" };
        break;
      }
    }

    if (outcome.state === "completed") {
      const persisted = await step.do(
        persistStepName(submission),
        { retries: { limit: PERSIST_RETRY_LIMIT, delay: exponentialRetryDelay }, timeout: "5 minutes" },
        async () => persistRawStep(env, params, submitted, fetchFn),
      );
      if (persisted.state === "persisted") {
        // 尽力释放服务端资源；失败 / 服务已下线都不影响任何结论。
        await step.do(releaseStepName(submission), { retries: { limit: 0, delay: "1 second" }, timeout: "30 seconds" }, async () => {
          await cancelTranscription(env, submitted.providerRequestId, fetchFn);
        });
        return persisted.rawKey;
      }
      lastFailure = { code: "transcription_failed", message: `transcription result unavailable (${persisted.reason})` };
    } else if (outcome.state === "failed") {
      if (!outcome.retryable) throw providerFailureError(outcome);
      lastFailure = { code: taskErrorCodeForProvider(outcome.code), message: outcome.message };
    } else if (outcome.state === "timeout") {
      await step.do(releaseStepName(submission), { retries: { limit: 0, delay: "1 second" }, timeout: "30 seconds" }, async () => {
        await cancelTranscription(env, submitted.providerRequestId, fetchFn);
      });
      lastFailure = { code: "transcription_timeout", message: "transcription exceeded the maximum allowed duration" };
    } else {
      lastFailure = { code: "transcription_failed", message: `transcription service lost the request (${outcome.reason})` };
    }

    if (submission < MAX_SUBMISSIONS) {
      await recordResubmit(env, params, step, submission);
    }
  }

  throw nonRetryable(lastFailure.code, lastFailure.message);
}

async function recordResubmit(env: Env, params: ProcessingWorkflowParams, step: StepRunner, submission: number): Promise<void> {
  await step.do(`note-resubmit-${submission}`, SMALL_STEP, async () => {
    await recordMessage(env, params, "转录未完成，正在重新提交…");
    await env.DB.prepare(`UPDATE tasks SET provider_request_id = NULL, transcription_phase = NULL, updated_at = ${NOW} WHERE ${OWNED_TRANSCRIBING}`)
      .bind(params.taskId, params.attemptId)
      .run();
  });
  await step.sleep(backoffStepName(submission), RESUBMIT_BACKOFF);
}

