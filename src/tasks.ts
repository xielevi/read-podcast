import { HttpError, error, json, parseLimit, parseOffset, readJson } from "./http";
import { episodeById } from "./episodes";
import { MAX_UPLOAD_BYTES } from "./limits";
import { STAGE_PROGRESS_RANGES, mapGlobalProgress } from "./progress";
import { purgeRaw, resolveExistingRawKey } from "./raw";
import { cancelTranscription } from "./transcription/client";
import { uploadIdFromAudioUrl } from "./transcription/source";
import { deleteUploadObjects } from "./uploads";
import { processingWorkflowId, processingWorkflowStatus, startProcessingWorkflow, terminateProcessingWorkflow } from "./workflows/processing";
import { NOW, loadTaskRow, type TaskRow } from "./db";
import type { Env, TaskStatus } from "./types";

export { STAGE_PROGRESS_RANGES, mapGlobalProgress };

// 任务生命周期：Cloudflare 拥有从创建到成稿的全部状态。
//   active   : queued / transcribing / refining / finalizing
//   terminal : success / error / cancelled
const ACTIVE_STATUSES: TaskStatus[] = ["queued", "transcribing", "refining", "finalizing"];
const ACTIVE_SET = new Set<TaskStatus>(ACTIVE_STATUSES);
const ACTIVE_PLACEHOLDERS = ACTIVE_STATUSES.map(() => "?").join(",");

// 前端 PublicTask 状态口径：把内部枚举映射为 pending/running/success/failed/cancelled。
const STATUS_TO_PUBLIC: Record<TaskStatus, string> = {
  queued: "pending",
  transcribing: "running",
  refining: "running",
  finalizing: "running",
  success: "success",
  error: "failed",
  cancelled: "cancelled",
};

export function toPublicTask(row: TaskRow): Record<string, unknown> {
  const isSuccess = row.status === "success";
  const isFinalizing = row.status === "finalizing";

  let publicStatus = STATUS_TO_PUBLIC[row.status] ?? row.status;
  // 转录阶段的子阶段由转录服务上报、Cloudflare 镜像：获取 / 准备音频 → 「下载」，转录 → 「转录」。
  let stage: string = row.status === "transcribing" && row.transcription_phase !== "transcribing" ? "downloading" : row.status;
  let progress = row.progress;
  let message = row.message;

  if (isFinalizing) {
    stage = "finalizing";
    progress = Math.max(95, row.progress);
    publicStatus = "running";
    message = row.message || "正在保存正式稿…";
  } else if (isSuccess) {
    stage = "success";
    progress = 100;
    publicStatus = "success";
  }

  return {
    id: row.id,
    episode_id: row.episode_id,
    podcast_name: row.podcast_name,
    episode_title: row.episode_title,
    status: publicStatus,
    progress_pct: progress,
    stage,
    message,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function asNonEmpty(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_request", `${field} is required`);
  }
  return value.trim().slice(0, max);
}

/** 启动 Processing Workflow；失败不丢任务——任务保持 queued，由 recovery sweep 继续尝试（Cloudflare 才是权威）。 */
async function startProcessingSafely(env: Env, taskId: string, attemptId: string): Promise<void> {
  try {
    await startProcessingWorkflow(env, taskId, attemptId);
  } catch (caught) {
    console.error(`Failed to start processing workflow for task ${taskId}:`, caught);
  }
}

function isUniqueViolation(caught: unknown): boolean {
  return /UNIQUE/i.test(caught instanceof Error ? caught.message : String(caught));
}

/** POST /tasks —— 从真实单集创建：`{episode_id, force}`，按主键读取 D1 单集。 */
export async function createTask(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<{ episode_id?: string; force?: boolean }>(request);
  const force = body.force === true;
  const episode = await episodeById(env, asNonEmpty(body.episode_id, "episode_id", 1000));
  if (!episode) return error(404, "episode_not_found", "未找到该单集，请刷新节目列表后重试");

  if (!force) {
    const done = await env.db.prepare("SELECT task_id FROM articles WHERE episode_id = ? LIMIT 1").bind(episode.id).first<{ task_id: string }>();
    if (done) return error(409, "already_processed", "该节目已转录完成，如需重做请点击「重新转录」。");
  }

  const active = await env.db.prepare(
    `SELECT id FROM tasks WHERE episode_id = ? AND status IN (${ACTIVE_PLACEHOLDERS}) ORDER BY created_at DESC LIMIT 1`,
  ).bind(episode.id, ...ACTIVE_STATUSES).first<{ id: string }>();
  if (active) return json({ task_id: active.id, status: "existing" });

  const id = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  try {
    await env.db.prepare(`INSERT INTO tasks
      (id, episode_id, source_type, podcast_name, episode_title, audio_url, status, message, current_attempt_id)
      VALUES (?, ?, 'rss', ?, ?, ?, 'queued', '已排队，等待转录', ?)`)
      .bind(id, episode.id, episode.podcast_name, episode.title, episode.audio_url, attemptId)
      .run();
  } catch (caught) {
    const existing = await env.db.prepare(
      `SELECT id FROM tasks WHERE episode_id = ? AND status IN (${ACTIVE_PLACEHOLDERS}) ORDER BY created_at DESC LIMIT 1`,
    ).bind(episode.id, ...ACTIVE_STATUSES).first<{ id: string }>();
    if (existing) return json({ task_id: existing.id, status: "existing" });
    throw caught;
  }

  await startProcessingSafely(env, id, attemptId);
  return json({ task_id: id, status: "created" }, 202);
}

/** POST /tasks/custom —— 创建自定义上传音频任务。 */
export async function createCustomTask(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<{ upload_id?: string; title?: string; prompt_template_id?: string; custom_prompt?: string }>(request);
  const uploadId = asNonEmpty(body.upload_id, "upload_id", 100);

  // 校验 R2 uploads/ 是否存在该上传文件
  const prefix = `uploads/${uploadId}/`;
  const listed = await env.storage.list({ prefix, limit: 1 });
  if (listed.objects.length === 0) {
    return error(404, "upload_not_found", "上传音频未找到或已过期，请重新上传");
  }

  const audioObject = listed.objects[0];
  // 200 MiB 硬上限的最后一道闸：无论对象是怎么进入 R2 的，超限的音频都不能成为任务。
  if (audioObject.size > MAX_UPLOAD_BYTES) {
    await deleteUploadObjects(env, uploadId).catch(() => undefined);
    return error(413, "file_too_large", `音频超过 ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB 上限，已丢弃，请压缩或截取后重新上传`);
  }

  const audioKey = audioObject.key;
  const parts = audioKey.split("/");
  const originalFilename = parts.length >= 3 ? parts.slice(2).join("/") : "audio.mp3";
  const rawTitle = (body.title || "").trim();
  const title = (rawTitle || originalFilename).replace(/\.(mp3|m4a|wav|flac|ogg|aac|opus|wma|webm|mp4)$/i, "").trim() || "未命名音频";
  const customPrompt = (body.custom_prompt || "").trim() || null;

  const id = crypto.randomUUID();
  const attemptId = crypto.randomUUID();

  await env.db.prepare(`INSERT INTO tasks
    (id, episode_id, source_type, podcast_name, episode_title, audio_url, status, message, current_attempt_id, custom_prompt)
    VALUES (?, NULL, 'upload', '本地音频', ?, ?, 'queued', '已排队，等待转录', ?, ?)`)
    .bind(id, title, `r2://${audioKey}`, attemptId, customPrompt)
    .run();

  await startProcessingSafely(env, id, attemptId);
  return json({ task_id: id, status: "created" }, 202);
}

/**
 * GET /tasks —— 最近的任务；`?status=` 按单个内部状态过滤；`?active=true` 只返回进行中的任务
 * （前端的单一轮询器每轮只发这一个请求，见 public/js/40-tasks.js createTaskPoller）。
 */
export async function listTasks(url: URL, env: Env): Promise<Response> {
  const limit = parseLimit(url, 20, 200);
  const status = url.searchParams.get("status");
  const statement = url.searchParams.get("active") === "true"
    ? env.db.prepare(`SELECT * FROM tasks WHERE status IN (${ACTIVE_PLACEHOLDERS}) ORDER BY created_at DESC LIMIT ?`).bind(...ACTIVE_STATUSES, 200)
    : status
      ? env.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?").bind(status, limit)
      : env.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").bind(limit);
  const result = await statement.all<TaskRow>();
  return json(result.results.map(toPublicTask));
}

export async function getTask(id: string, env: Env): Promise<Response> {
  const task = await loadTaskRow(env, id);
  return task ? json(toPublicTask(task)) : error(404, "task_not_found", "Task not found");
}

/**
 * DELETE /tasks/:id —— Cloudflare 是取消的唯一权威：
 * - 活跃（queued / transcribing / refining）：CAS 记录取消意图 → terminate Workflow → D1 cancelled；
 *   若已向转录服务提交，则**尽力**通知它取消（best-effort，失败 / 无响应不影响任务的最终状态）；
 * - finalizing 状态一律 409 finalizing，保持不可取消语义；
 * - 终态失败 / 取消 → 删除；成功 → 保留。
 * Workflow 的每个 step 都会重新校验 cancel_requested，因此即便 terminate 失败也不会继续产出任何副作用。
 */
export async function cancelOrDeleteTask(id: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  const task = await loadTaskRow(env, id);
  if (!task) return error(404, "task_not_found", "Task not found");

  if (task.status === "finalizing") {
    return error(409, "finalizing", "Task is finalizing and cannot be cancelled");
  }
  if (ACTIVE_SET.has(task.status)) {
    return cancelActiveTask(env, ctx, task);
  }
  if (task.status === "error" || task.status === "cancelled") {
    await env.db.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
    // 记录删除后其 R2 原始转录也无意义了，顺手清理（lifecycle 亦兜底）。
    ctx.waitUntil(purgeRaw(env, id).catch(() => undefined));
    return json({ task_id: id, status: "deleted" });
  }
  return error(409, "task_completed", "已完成稿件请在稿件库中保留");
}

async function cancelActiveTask(env: Env, ctx: ExecutionContext, task: TaskRow): Promise<Response> {
  // 原子 CAS 记录取消意图：只能在 queued / transcribing / refining 时置 1，finalizing 不可取消
  const marked = await env.db.prepare(`UPDATE tasks SET cancel_requested = 1, message = '取消中…', updated_at = ${NOW}
    WHERE id = ? AND status IN ('queued', 'transcribing', 'refining') AND cancel_requested = 0`)
    .bind(task.id)
    .run();

  if (!marked.meta.changes) {
    const current = await env.db.prepare("SELECT status, cancel_requested FROM tasks WHERE id = ?")
      .bind(task.id)
      .first<{ status: string; cancel_requested: number }>();
    if (!current) return error(404, "task_not_found", "Task not found");
    if (current.status === "finalizing" || current.status === "success") {
      return error(409, "finalizing", "Task is finalizing and cannot be cancelled");
    }
    // 重复取消（cancel_requested 已为 1）是幂等的；其余终态不可取消。
    if (!current.cancel_requested && !ACTIVE_SET.has(current.status as TaskStatus)) {
      return error(409, "not_cancellable", `Task is not cancellable in state ${current.status}`);
    }
  }

  // 取最新的 provider 句柄与 attempt id
  const latest = await env.db.prepare("SELECT provider_request_id, current_attempt_id FROM tasks WHERE id = ?")
    .bind(task.id)
    .first<{ provider_request_id: string | null; current_attempt_id: string | null }>();

  const attemptId = latest?.current_attempt_id ?? task.current_attempt_id ?? "";
  if (attemptId) {
    await terminateProcessingWorkflow(env, task.id, attemptId);
  }

  await env.db.prepare(`UPDATE tasks SET status = 'cancelled', message = '任务已取消', transcription_phase = NULL,
    completed_at = ${NOW}, updated_at = ${NOW}
    WHERE id = ? AND status != 'success' AND status != 'finalizing'`)
    .bind(task.id)
    .run();

  const providerRequestId = latest?.provider_request_id ?? task.provider_request_id;
  if (providerRequestId) ctx.waitUntil(cancelTranscription(env, providerRequestId));
  return json({ task_id: task.id, status: "cancelled" });
}

/**
 * 这些错误意味着 raw 本身不可用（转录退化 / 占位模式产物），本质属于 transcription
 * failure：retry 时绝不能把 bad raw 当 retry asset 复用（否则无限循环 refine_raw_too_short），
 * 必须整体清空该 task 的 raw lineage 后重新转录。
 */
const TRANSCRIPTION_INVALID_ERRORS = new Set(["refine_raw_too_short", "transcription_invalid"]);

/**
 * POST /tasks/:id/retry —— 失败/取消任务重跑。所有重试都是「轮换 attempt → 新的 Processing Workflow」，
 * 由 Workflow 的 resolve-raw 决定要不要转录：
 * - raw 存在（R2）→ 直接精修，**不联系转录服务**（精修失败、质量门禁、GitHub 故障都走这条）；
 * - 转录不可用类错误（refine_raw_too_short / transcription_invalid）→ 先清空整条 raw lineage，再重新转录；
 * - raw 缺失：RSS → 重新转录；upload → 原音频仍在则重新转录，否则 409 upload_expired。
 */
export async function retryTask(id: string, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const task = await loadTaskRow(env, id);
  if (!task) return error(404, "task_not_found", "Task not found");
  if (task.status !== "error" && task.status !== "cancelled") {
    return error(409, "task_not_retriable", "只有失败或已取消的任务可以重试");
  }

  // bad raw 不是 retry asset：整条 raw lineage 都不可信——必须清掉 raw/<task>/ 下**所有** attempt 的原始转录，
  // 否则 resolve-raw 会命中历史 raw、永远不重新转录。
  const transcriptionInvalid = TRANSCRIPTION_INVALID_ERRORS.has(task.error_code ?? "");
  if (transcriptionInvalid) {
    await purgeRaw(env, id).catch(() => undefined);
  }
  const rawKey = transcriptionInvalid ? null : await resolveExistingRawKey(env, id, task.raw_object_key);

  if (!rawKey && task.source_type === "upload") {
    const uploadId = uploadIdFromAudioUrl(task.audio_url);
    const uploadListing = uploadId ? await env.storage.list({ prefix: `uploads/${uploadId}/`, limit: 1 }) : { objects: [] };
    if (uploadListing.objects.length === 0) {
      return error(409, "upload_expired", "原音频与转录缓存均已过期，请重新上传音频");
    }
  }

  const attemptId = crypto.randomUUID();
  try {
    const rotated = await env.db.prepare(`UPDATE tasks SET status = 'queued', progress = 0,
      message = ?, current_attempt_id = ?, raw_object_key = ?, provider_request_id = NULL,
      transcription_phase = NULL, refinement_started_at = NULL, cancel_requested = 0,
      error_code = NULL, completed_at = NULL, updated_at = ${NOW}
      WHERE id = ? AND status IN ('error', 'cancelled')`)
      .bind(rawKey ? "已有原始转录，排队精修" : "已排队，等待转录", attemptId, rawKey, id)
      .run();
    if (!rotated.meta.changes) {
      return error(409, "retry_conflict", "任务状态已变化，请刷新后重试");
    }
  } catch (caught) {
    if (isUniqueViolation(caught)) return error(409, "episode_active", "该单集已有进行中的任务");
    throw caught;
  }

  await startProcessingSafely(env, id, attemptId);
  return json({ task_id: id, status: "queued" }, 202);
}

export async function taskContent(id: string, env: Env): Promise<Response> {
  const task = await env.db.prepare("SELECT final_content_path FROM tasks WHERE id = ? AND status = 'success'").bind(id).first<{ final_content_path: string | null }>();
  if (!task?.final_content_path) return error(404, "content_not_found", "Completed content not found");
  const markdown = await env.manuscripts.read(task.final_content_path);
  if (markdown === null) return error(404, "content_not_found", "Completed content not found");
  return new Response(markdown, {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function taskDownload(id: string, env: Env): Promise<Response> {
  const task = await env.db.prepare("SELECT episode_title, final_content_path FROM tasks WHERE id = ? AND status = 'success'")
    .bind(id).first<{ episode_title: string; final_content_path: string | null }>();
  if (!task?.final_content_path) return error(404, "content_not_found", "Completed content not found");
  const markdown = await env.manuscripts.read(task.final_content_path);
  if (markdown === null) return error(404, "content_not_found", "Completed content not found");
  const filename = encodeURIComponent(`${task.episode_title || "podcast"}.md`);
  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${filename}`,
      "cache-control": "private, no-store",
    },
  });
}

// ── Cloudflare 自有的恢复（recovery）：没有任何外部节点参与 ──

/**
 * 启动 Processing Workflow 的兜底：任务已 queued（创建请求在 INSERT 与
 * Workflow 创建之间崩溃 / Workflows 暂时不可用 / 升级迁移后重新排队）。
 * 启动是幂等的（确定性 instance id）；超过 30 分钟仍无法启动则转 error，避免任务永久停在 queued。
 */
export async function recoverQueuedTasks(env: Env, limit = 10): Promise<number> {
  const stuck = await env.db.prepare(`SELECT id, current_attempt_id, created_at, updated_at FROM tasks
    WHERE status = 'queued' AND current_attempt_id IS NOT NULL AND cancel_requested = 0
      AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-45 seconds')
    ORDER BY created_at ASC LIMIT ?`)
    .bind(limit)
    .all<{ id: string; current_attempt_id: string; created_at: string; updated_at: string }>();

  let started = 0;
  for (const task of stuck.results) {
    if (!task.current_attempt_id) continue;
    const age = Date.now() - Date.parse(task.updated_at);
    if (Number.isFinite(age) && age > 30 * 60_000) {
      await env.db.prepare(`UPDATE tasks SET status = 'error', error_code = 'workflow_unavailable',
        message = '无法启动处理工作流，请稍后重试', completed_at = ${NOW}, updated_at = ${NOW}
        WHERE id = ? AND current_attempt_id = ? AND status = 'queued'`)
        .bind(task.id, task.current_attempt_id)
        .run();
      continue;
    }
    try {
      await startProcessingWorkflow(env, task.id, task.current_attempt_id);
      started += 1;
    } catch (caught) {
      console.error(`Recovery could not start workflow for task ${task.id}:`, caught);
    }
  }
  return started;
}

const DEAD_WORKFLOW_STATUSES = new Set(["errored", "terminated", "complete"]);

/**
 * Workflow 存活对账：活跃任务的 Workflow instance 明确处于 errored / terminated / complete，
 * 而 D1 仍停在活跃态（平台事故 / 失败记录丢失）→ 收敛为可重试的 error(workflow_lost)，raw 保留。
 * finalizing 状态在获得明确 terminal status 时有 10 分钟快速收敛窗口；其余活跃态 30 分钟。
 * 若 status 查询异常 / 返回 null（查询失败或实例丢失），不当作明确终态，统一采用 6 小时保守兜底，
 * 绝不在 10-15 分钟内仅凭一次查询失败把正常运行的 finalizing 误判为 workflow_lost。
 */
export async function reconcileWorkflowLiveness(env: Env, limit = 20): Promise<number> {
  const candidates = await env.db.prepare(`SELECT id, status, current_attempt_id, updated_at FROM tasks
    WHERE status IN (${ACTIVE_PLACEHOLDERS}) AND cancel_requested = 0
      AND current_attempt_id IS NOT NULL
      AND (
        (status = 'finalizing' AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'))
        OR (status IN ('queued', 'transcribing', 'refining') AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'))
      )
    ORDER BY updated_at ASC LIMIT ?`)
    .bind(...ACTIVE_STATUSES, limit)
    .all<{ id: string; status: TaskStatus; current_attempt_id: string; updated_at: string }>();

  let lost = 0;
  for (const task of candidates.results) {
    const instanceId = processingWorkflowId(task.id, task.current_attempt_id);
    const status = await processingWorkflowStatus(env, instanceId);
    const isDeadWorkflow = status !== null && DEAD_WORKFLOW_STATUSES.has(status);
    const isVanished = status === null && Date.now() - Date.parse(task.updated_at) > 6 * 3_600_000;
    if (!isDeadWorkflow && !isVanished) continue;
    const res = await env.db.prepare(`UPDATE tasks SET status = 'error', error_code = 'workflow_lost',
      message = '处理工作流异常终止，请重试', transcription_phase = NULL, completed_at = ${NOW}, updated_at = ${NOW}
      WHERE id = ? AND current_attempt_id = ? AND status IN (${ACTIVE_PLACEHOLDERS})`)
      .bind(task.id, task.current_attempt_id, ...ACTIVE_STATUSES)
      .run();
    lost += res.meta.changes ?? 0;
  }
  return lost;
}

/** Cron Trigger 入口：两类 Cloudflare 自有的收敛动作，互相独立、逐个 best-effort。 */
export async function runMaintenance(env: Env): Promise<{ started: number; lost: number }> {
  const result = { started: 0, lost: 0 };
  result.started = await recoverQueuedTasks(env).catch(() => 0);
  result.lost = await reconcileWorkflowLiveness(env).catch(() => 0);
  return result;
}

