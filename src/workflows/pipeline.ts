/**
 * Processing 管线（ProcessingWorkflow 的可测试实现体）。
 *
 * Cloudflare 从任务创建起拥有整条 durable 主链：
 *
 *   resolve-raw ─┬─ raw 已存在 ───────────────────────────────┐
 *                └─ 无 raw：start-transcription                │
 *                     → submit-transcription-N                 │   （见 ./transcription.ts）
 *                     → poll-transcription-N-k …               │
 *                     → persist-raw-N（raw → R2）              │
 *                                                              ▼
 *   claim-refinement (65%)
 *     → refine（外部 LLM，唯一昂贵调用；写入 R2 checkpoint，返回 key）
 *     → validate-and-publish（质量门禁 90% → Formatter → GitHub → D1 success 100%）
 *
 * 各阶段互不重做：step 输出被 durable 持久化，replay / retry 时已完成的 step 不会重新执行——
 * raw 落库后任何重试都不再转录；精修失败只重跑精修；publish 失败只重试 publish。
 * 转录服务只是被调用的外部计算：raw 落 R2 之后它是否在线与本管线无关。
 */
import { FinalizeError, persistFinalArticle } from "../finalize";
import { buildFilenameBase } from "../refinement/naming";
import { formatMarkdown, manuscriptTimeZone } from "../refinement/formatter";
import { verifyRefinementQuality } from "../refinement/quality";
import {
  REFINE_RETRY_LIMIT,
  REFINE_STEP_TIMEOUT,
  PUBLISH_STEP_TIMEOUT,
  MIN_REAL_TRANSCRIPT_CHARS,
  DEFAULT_REFINE_PROMPT,
  DEFAULT_REFINE_PROMPT_EN,
  REFINER_SYSTEM_PROMPT,
  REFINER_SYSTEM_PROMPT_EN,
} from "../refinement/defaults";
import { resolveContentLanguage } from "../language";
import {
  RefinerError,
  buildRefineMessages,
  buildRefinePrompt,
  callChatCompletion,
  extractMarkdown,
  type RefinerConfigSnapshot,
} from "../refinement/refiner";
import type { Env } from "../types";
import { processingWorkflowId } from "./processing";
import { NOW, loadTaskRow, type TaskRow } from "../db";
import {
  assertAttemptCurrent,
  assertTaskOwned,
  exponentialRetryDelay,
  nonRetryable,
  workflowError,
  type ProcessingWorkflowParams,
  type WorkflowStepLike,
} from "./common";
import { runTranscriptionPhase, type PollTuning } from "./transcription";

export const CLAIM_STEP = "claim-refinement";
export const REFINE_STEP = "refine";
export const PUBLISH_STEP = "validate-and-publish";
export const FAILURE_STEP = "record-failure";

// 说明：MIN_REAL_TRANSCRIPT_CHARS 的唯一权威定义在 ../refinement/defaults.ts
// （ownership handoff 与 refine step 双侧使用同一阈值）。
export { MIN_REAL_TRANSCRIPT_CHARS };

export interface ProcessingPipelineResult {
  taskId: string;
  attemptId: string;
  finalPath: string;
  commitSha: string;
}

export interface EpisodeContext {
  title: string;
  podcastName: string;
  published: string;
  duration: string;
  audioUrl: string;
  link: string;
  summary: string;
  date: string;
}

// ── 数据访问 ──

interface EpisodeRow {
  podcast_name: string | null;
  title: string | null;
  audio_url: string | null;
  summary: string | null;
  link: string | null;
  published: string | null;
  published_date: string | null;
  duration: string | null;
}

/** 从 RSS 原文解析 YYYYMMDD（按字符串自身时区语义，与原生实现一致）。 */
export function dateFromPublished(published: string): string {
  const text = (published ?? "").trim();
  if (!text) return "";
  const match = /^[A-Za-z]{3},\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})/.exec(text);
  if (match) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const monthIndex = months.indexOf(match[2].toLowerCase());
    if (monthIndex >= 0) {
      return `${match[3]}${String(monthIndex + 1).padStart(2, "0")}${match[1].padStart(2, "0")}`;
    }
  }
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    const date = new Date(parsed);
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  return "";
}

export function resolveDate(dateStr: string | null, published: string | null, fallbackDate: Date = new Date()): string {
  const explicit = (dateStr ?? "").trim();
  if (explicit) return explicit;
  const parsed = dateFromPublished(published ?? "");
  if (parsed) return parsed;
  return `${fallbackDate.getUTCFullYear()}${String(fallbackDate.getUTCMonth() + 1).padStart(2, "0")}${String(fallbackDate.getUTCDate()).padStart(2, "0")}`;
}

export async function loadEpisodeContext(env: Env, task: TaskRow): Promise<EpisodeContext> {
  if (task.episode_id) {
    const row = await env.db.prepare(
      "SELECT podcast_name, title, audio_url, summary, link, published, published_date, duration FROM episodes WHERE id = ?",
    )
      .bind(task.episode_id)
      .first<EpisodeRow>();
    if (row) {
      return {
        title: String(row.title ?? task.episode_title),
        podcastName: String(row.podcast_name ?? task.podcast_name),
        published: String(row.published ?? ""),
        duration: String(row.duration ?? ""),
        audioUrl: String(row.audio_url ?? task.audio_url ?? ""),
        link: String(row.link ?? ""),
        summary: String(row.summary ?? ""),
        date: resolveDate(row.published_date, row.published),
      };
    }
  }
  // 自定义上传 / 无 episode 索引：沿用原 upload 快照语义。
  const created = (task.created_at ?? "").slice(0, 10).replace(/-/g, "");
  return {
    title: task.episode_title,
    podcastName: task.podcast_name || "本地音频",
    published: task.created_at ?? "",
    duration: "",
    audioUrl: task.audio_url ?? "",
    link: "",
    summary: "",
    date: resolveDate(created, ""),
  };
}

async function markProgress(env: Env, params: ProcessingWorkflowParams, progress: number, message: string): Promise<void> {
  await env.db.prepare(`UPDATE tasks SET progress = MAX(progress, ?), message = ?, updated_at = ${NOW}
    WHERE id = ? AND current_attempt_id = ? AND cancel_requested = 0 AND status IN ('refining', 'finalizing')`)
    .bind(progress, message, params.taskId, params.attemptId)
    .run();
}

// ── Step 1: claim-refinement ──

export async function claimRefinement(env: Env, params: ProcessingWorkflowParams, instanceId: string, rawKey: string): Promise<void> {
  const expectedInstanceId = processingWorkflowId(params.taskId, params.attemptId);
  if (instanceId !== expectedInstanceId) {
    throw nonRetryable("workflow_conflict", "Workflow instance does not match task attempt");
  }
  const task = assertTaskOwned(await loadTaskRow(env, params.taskId), params.attemptId);
  if (task.raw_object_key !== rawKey) throw nonRetryable("raw_mismatch", "Raw transcript key does not match the persisted object");

  const result = await env.db.prepare(`UPDATE tasks
    SET status = 'refining',
        progress = MAX(progress, 65),
        message = 'Edge AI 精修中',
        transcription_phase = NULL,
        refinement_started_at = COALESCE(refinement_started_at, ${NOW}),
        updated_at = ${NOW}
    WHERE id = ?
      AND current_attempt_id = ?
      AND cancel_requested = 0
      AND raw_object_key = ?
      AND status IN ('queued', 'transcribing', 'refining')`)
    .bind(params.taskId, params.attemptId, rawKey)
    .run();

  if (!result.meta.changes) {
    const current = await loadTaskRow(env, params.taskId);
    assertTaskOwned(current, params.attemptId);
    // 纯竞态（状态在毫秒级窗口内变化）→ 允许重试一次再判定
    throw new Error("claim_race: task state changed during refinement claim");
  }
}

// ── Step 2: refine（唯一昂贵的 LLM 调用） ──

export async function refineStep(
  env: Env,
  params: ProcessingWorkflowParams,
  rawKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const task = assertAttemptCurrent(await loadTaskRow(env, params.taskId), params.attemptId);

  const rawObject = await env.storage.get(rawKey);
  if (!rawObject) throw nonRetryable("refine_raw_missing", "R2 raw transcript is missing");
  const rawText = await rawObject.text();
  if (!rawText.trim()) throw nonRetryable("refine_raw_missing", "R2 raw transcript is empty");
  // 完整性护栏：真实播客转录不可能只有几十字符。过短的 raw 说明上游转录退化
  // （例如转录引擎在占位模式下返回假文本），此时必须失败而不是让模型
  // 基于 RSS 简介「编造」一篇看似完整的稿件。
  const rawChars = rawText.replace(/\s+/g, "").length;
  if (rawChars < MIN_REAL_TRANSCRIPT_CHARS) {
    throw nonRetryable(
      "refine_raw_too_short",
      `Raw transcript is implausibly short (${rawChars} non-space chars); transcription likely failed`,
    );
  }

  let contentLang = task.content_language;
  if (!contentLang) {
    contentLang = resolveContentLanguage(null, env.TRANSCRIPTION_LANGUAGE, rawText);
    await env.db.prepare(`UPDATE tasks SET content_language = ?, updated_at = ${NOW} WHERE id = ?`)
      .bind(contentLang, task.id)
      .run();
  }

  const context = await loadEpisodeContext(env, task);
  const prompt = buildRefinePrompt(
    context.summary,
    task.custom_prompt,
    contentLang === "en" ? DEFAULT_REFINE_PROMPT_EN : DEFAULT_REFINE_PROMPT,
  );
  const messages = buildRefineMessages(
    prompt,
    rawText,
    contentLang === "en" ? REFINER_SYSTEM_PROMPT_EN : REFINER_SYSTEM_PROMPT,
  );

  let markdown: string;
  try {
    const result = await callChatCompletion({
      apiBase: params.config.apiBase,
      model: params.config.model,
      apiKey: env.REFINER_API_KEY,
      messages,
      maxTokens: params.config.maxTokens,
      temperature: params.config.temperature,
      fetchFn,
    });
    markdown = extractMarkdown(result.content);
    if (!markdown.trim()) throw nonRetryable("refine_empty_output", "Refiner produced empty output");
  } catch (error) {
    if (error instanceof RefinerError) {
      throw workflowError(error.code, error.message, { retryable: error.retryable, retryAfterSeconds: error.retryAfterSeconds });
    }
    throw error;
  }

  // 质量门禁：在 refine 步骤内与内存中已有的 rawText 一同校验，整条管线只读取一次 R2 raw
  const gate = verifyRefinementQuality(markdown, rawText, params.config.minOutputRatio);
  if (!gate.valid) {
    throw nonRetryable("refine_quality_gate", `AI 精修未通过质量门禁 (${gate.features.join(", ")})`);
  }

  const refinedKey = `refined/${params.taskId}/${params.attemptId}.md`;
  await env.storage.put(refinedKey, markdown, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });
  return refinedKey;
}

// ── Step 3: validate-and-publish（Formatter + GitHub + D1） ──

/**
 * 成稿时间戳必须对同一 (task, attempt) 确定性：publish step 重放（isolate 崩溃后引擎
 * 重跑回调）时重新生成完全相同的 markdown，GitHub 幂等检查（同路径同内容 no-op）
 * 才能识别「已 commit 但 D1 尚未 success」的重放，绝不制造第二个内容 commit。
 */
function deterministicProcessedAt(task: { refinement_started_at: string | null; created_at: string }): Date {
  const basis = Date.parse(task.refinement_started_at ?? "");
  if (Number.isFinite(basis)) return new Date(basis);
  const fallback = Date.parse(task.created_at ?? "");
  return Number.isFinite(fallback) ? new Date(fallback) : new Date();
}

export async function publishStep(
  env: Env,
  params: ProcessingWorkflowParams,
  refinedKey: string,
): Promise<{ finalPath: string; commitSha: string }> {
  await markProgress(env, params, 95, "正在保存正式稿…");

  const task = assertAttemptCurrent(await loadTaskRow(env, params.taskId), params.attemptId);
  const refinedObject = await env.storage.get(refinedKey);
  if (!refinedObject) throw nonRetryable("refined_checkpoint_missing", "R2 refined checkpoint is missing or expired");
  const refinedText = await refinedObject.text();
  if (!refinedText.trim()) throw nonRetryable("refined_checkpoint_missing", "R2 refined checkpoint is empty");

  // 质量门禁已在 refineStep 校验通过，此处不再二次读取 R2 raw
  const context = await loadEpisodeContext(env, task);
  const writingFilename = await buildFilenameBase(context.podcastName, context.date, context.title);
  const markdown = formatMarkdown(
    {
      title: context.title,
      podcast_name: context.podcastName,
      published: context.published,
      duration: context.duration,
      audio_url: context.audioUrl,
      link: context.link,
    },
    refinedText,
    [],
    { refinement_success: true, transcript_source: "ai_refined" },
    deterministicProcessedAt(task),
    manuscriptTimeZone(env.MANUSCRIPT_TIME_ZONE),
  );

  try {
    const saved = await persistFinalArticle(env, {
      taskId: params.taskId,
      attemptId: params.attemptId,
      writingFilename,
      markdown,
    });
    return { finalPath: saved.finalPath, commitSha: saved.commitSha };
  } catch (error) {
    // GitHub / D1 临时故障 → step retry；其余 → NonRetryable
    if (error instanceof FinalizeError) throw workflowError(error.code, error.message, { retryable: error.retryable });
    throw error;
  }
}

// ── 失败归因 ──

export interface FailureRecord {
  code: string;
  message: string;
  skip?: boolean;
}

type PipelinePhase = "transcription" | "refinement";

const FAILURE_MESSAGES: Record<string, string> = {
  // 精修
  refine_provider_auth: "精修服务商鉴权失败，请检查 REFINER_API_KEY",
  refine_provider_bad_request: "精修请求参数错误，请检查精修模型与配置",
  refine_api_failed: "AI 精修调用失败，请重试",
  refine_quality_gate: "AI 精修未通过质量门禁，原始转录已保留，可重试",
  refine_raw_missing: "原始转录缓存已缺失或过期，请重新处理该单集",
  refine_raw_too_short: "原始转录异常过短（上游转录可能失败），已阻止生成稿件，请重新处理该单集",
  refined_checkpoint_missing: "精修检查点已缺失或过期，请重试任务",
  final_persist_failed: "成稿写入失败，请重试",
  // 转录（Cloudflare 判定；转录服务只报告事实）
  transcription_service_unavailable: "转录服务长时间不可用，请确认服务已启动后重试",
  transcription_service_auth: "Cloudflare Access 拒绝了转录服务请求，请检查 Access service token 与策略",
  transcription_service_unconfigured: "转录服务未配置，请检查 TRANSCRIPTION_SERVICE_URL / Cloudflare Access 凭据",
  r2_credentials_unconfigured: "Cloudflare 未配置签发临时音频链接所需的 R2 凭据（R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME）",
  transcription_request_rejected: "转录服务拒绝了该请求，请检查服务配置",
  transcription_protocol_error: "转录服务响应不符合协议，请检查服务版本",
  transcription_response_too_large: "转录结果体积异常，已拒收",
  transcription_timeout: "转录超时，请重试",
  transcription_failed: "语音转录失败，请重试",
  transcription_invalid: "原始转录异常，请重新转录",
  audio_download_failed: "音频获取失败，请检查音频链接后重试",
  provider_audio_fetch_failed: "云端转录服务无法获取该音频（可能存在防盗链或跳转限制），请检查音频链接，或改用自托管转录服务",
  provider_quota_exhausted: "云端转录额度不足或已用尽，请检查服务商账单与配额，或改用自托管转录服务",
  transcription_provider_unknown: "TRANSCRIPTION_PROVIDER 配置无效，只能是 self-hosted 或 dashscope",
  source_not_allowed: "音频地址不被允许（仅支持公网 http(s) 地址）",
  source_too_large: "音频超过大小上限，无法处理",
  upload_expired: "上传的音频已过期，请重新上传",
  raw_too_large: "原始转录体积异常，已拒收",
  // 基础设施
  workflow_lost: "处理工作流异常终止，请重试",
  workflow_unavailable: "无法启动处理工作流，请稍后重试",
};

const SKIPPED_CODES = new Set(["stale_attempt", "stale_provider_request", "task_not_found", "already_finalizing", "workflow_conflict", "already_success", "terminal"]);

/**
 * 从 Workflow 抛出的错误里取稳定 code。错误穿过 step 边界（重试耗尽 / NonRetryableError）时自定义属性
 * 会丢失，引擎还可能改写消息（例如 `Step threw a NonRetryableError with message "[code] …"`），
 * 因此依次尝试：`.code` → 消息里的 `[code]` 标记（任意位置）。
 *
 * 允许数字：`r2_credentials_unconfigured` 之类含数字的 code 也必须能归因（漏掉数字会让这类失败
 * 静默退化成 transcription_failed / refine_api_failed）。
 */
export function errorCodeOf(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  if (typeof candidate?.code === "string" && candidate.code) return candidate.code;
  const tagged = typeof candidate?.message === "string" ? /\[([a-z][a-z0-9_]*)\]/.exec(candidate.message) : null;
  return tagged?.[1] ?? "";
}

export function classifyFailure(error: unknown, phase: PipelinePhase = "refinement"): FailureRecord {
  if (error instanceof FinalizeError) {
    if (error.code === "final_persist_failed") {
      return { code: "final_persist_failed", message: FAILURE_MESSAGES.final_persist_failed };
    }
    // stale_attempt / not_running / already_finalizing / task_not_found：D1 已是事实，不覆写
    return { code: error.code, message: error.message, skip: true };
  }
  const fallback = phase === "transcription" ? "transcription_failed" : "refine_api_failed";
  const code = errorCodeOf(error);
  if (code === "cancelled" || code === "cancel_requested") {
    // 取消由 cancel 端点 / 本模块的 cancel 分支统一落库
    return { code: "cancelled", message: "任务已取消", skip: true };
  }
  if (SKIPPED_CODES.has(code)) {
    return { code, message: error instanceof Error ? error.message : code, skip: true };
  }
  if (code === "claim_race" || code === "refine_empty_output") {
    return { code: "refine_api_failed", message: FAILURE_MESSAGES.refine_api_failed };
  }
  if (code && FAILURE_MESSAGES[code]) return { code, message: FAILURE_MESSAGES[code] };
  return { code: fallback, message: FAILURE_MESSAGES[fallback] };
}

/**
 * 记录 Workflow 失败归因：绝不复活旧 attempt，绝不覆盖 success 任务。
 * 取消竞态下统一收敛为 cancelled。
 */
export async function markWorkflowFailure(env: Env, params: ProcessingWorkflowParams, error: unknown, phase: PipelinePhase = "refinement"): Promise<void> {
  const record = classifyFailure(error, phase);
  const task = await loadTaskRow(env, params.taskId);
  if (!task) return;
  if (task.current_attempt_id !== params.attemptId) return;
  if (task.status === "success") return;

  if (task.cancel_requested || task.status === "cancelled") {
    await env.db.prepare(`UPDATE tasks SET status = 'cancelled', message = '任务已取消',
      completed_at = ${NOW}, updated_at = ${NOW}
      WHERE id = ? AND status != 'success'`)
      .bind(params.taskId)
      .run();
    return;
  }
  if (record.skip) return;

  await env.db.prepare(`UPDATE tasks SET status = 'error', error_code = ?, message = ?, transcription_phase = NULL,
    completed_at = ${NOW}, updated_at = ${NOW}
    WHERE id = ? AND current_attempt_id = ? AND status NOT IN ('success', 'cancelled')`)
    .bind(record.code, record.message, params.taskId, params.attemptId)
    .run();
}

// ── 管线入口 ──

export interface ProcessingDeps {
  fetchFn?: typeof fetch;
  poll?: PollTuning;
}

export async function runProcessingPipeline(
  env: Env,
  params: ProcessingWorkflowParams,
  instanceId: string,
  step: WorkflowStepLike,
  deps: ProcessingDeps = {},
): Promise<ProcessingPipelineResult> {
  let phase: PipelinePhase = "transcription";
  try {
    // 阶段一：拿到 raw。R2 已有可信 raw → 直接返回，绝不重新转录；否则由 Cloudflare 驱动转录服务。
    const rawKey = await runTranscriptionPhase(env, params, instanceId, step, deps.fetchFn ?? fetch, deps.poll);

    // 阶段二：精修 → 质量门禁 → 成稿。转录服务此后是否在线与本阶段无关。
    phase = "refinement";
    await step.do(CLAIM_STEP, { retries: { limit: 2, delay: "5 seconds" }, timeout: "2 minutes" }, async () =>
      claimRefinement(env, params, instanceId, rawKey),
    );

    const refinedKey = await step.do(
      REFINE_STEP,
      { retries: { limit: REFINE_RETRY_LIMIT, delay: exponentialRetryDelay }, timeout: REFINE_STEP_TIMEOUT },
      async () => refineStep(env, params, rawKey, deps.fetchFn ?? fetch),
    );

    const published = await step.do(
      PUBLISH_STEP,
      { retries: { limit: REFINE_RETRY_LIMIT, delay: exponentialRetryDelay }, timeout: PUBLISH_STEP_TIMEOUT },
      async () => publishStep(env, params, refinedKey),
    );

    return {
      taskId: params.taskId,
      attemptId: params.attemptId,
      finalPath: published.finalPath,
      commitSha: published.commitSha,
    };
  } catch (error) {
    try {
      await step.do(FAILURE_STEP, { retries: { limit: 2, delay: "10 seconds" } }, async () =>
        markWorkflowFailure(env, params, error, phase),
      );
    } catch (recordError) {
      console.error("Failed to record workflow failure:", recordError);
    }
    throw error;
  }
}

