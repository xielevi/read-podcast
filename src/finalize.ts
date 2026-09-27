/**
 * 最终成稿持久化（ProcessingWorkflow publish step 调用的核心逻辑）。
 *
 * 保留的并发边界：
 * - status = 'finalizing' CAS：进入成稿阶段后状态明确为 finalizing，不可取消；
 *   同一 attempt 的 publish step replay（isolate 崩溃 / 引擎重试）允许直接继续；
 *   不同 attempt / 已取消 / 终态一律拒绝；
 * - cancel vs finalization race：cancel_requested = 1 时拒绝进入 finalizing；
 * - current_attempt_id CAS：旧 attempt 的提交不允许落库；
 * - Store publish first（GitHub commit 或本地目录写入）→ D1 task success + article upsert 原子 batch；
 * - Store 临时故障保持 status = 'finalizing' 并抛 retryable error，由 publish step durable retry
 *   直接重试（利用两种实现同内容发布的幂等性，不额外制造 commit / 版本）；
 * - publish 重试最终耗尽时，由 Workflow 外层 failure handling 统一收敛为 error(final_persist_failed)。
 */
import { MAX_FINAL_MARKDOWN_BYTES } from "./refinement/defaults";
import { NOW } from "./db";
import type { Env } from "./types";

export type FinalizeErrorCode =
  | "final_persist_failed"
  | "stale_attempt"
  | "cancelled"
  | "task_not_found"
  | "already_finalizing"
  | "not_running";

export class FinalizeError extends Error {
  readonly code: FinalizeErrorCode;
  readonly retryable: boolean;

  constructor(code: FinalizeErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "FinalizeError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface PersistFinalArticleInput {
  taskId: string;
  attemptId: string;
  // 稿件文件名唯一来源：Edge 侧 build_filename_base 产物。
  writingFilename: string;
  markdown: string;
}

interface FinalizeTaskRow {
  status: string;
  current_attempt_id: string | null;
  cancel_requested: number;
  error_code: string | null;
  final_content_path: string | null;
  content_commit_sha: string | null;
}


export async function persistFinalArticle(
  env: Env,
  input: PersistFinalArticleInput,
): Promise<{ finalPath: string; commitSha: string }> {
  const markdown = (input.markdown ?? "").trim();
  if (!markdown) throw new FinalizeError("final_persist_failed", "final_markdown is empty", false);
  if (markdown.length > MAX_FINAL_MARKDOWN_BYTES) {
    throw new FinalizeError("final_persist_failed", "final_markdown exceeds 5MB limit", false);
  }

  // 原子 CAS 进入 finalizing 状态：
  // 1. refining → finalizing（正常路径）
  // 2. same attempt + already finalizing → resume（同一 Workflow publish step 重试 / 重放）
  const claim = await env.db.prepare(`
    UPDATE tasks
    SET status = 'finalizing',
        progress = MAX(progress, 95),
        message = '正在保存正式稿…',
        updated_at = ${NOW}
    WHERE id = ?
      AND current_attempt_id = ?
      AND cancel_requested = 0
      AND (status = 'refining' OR status = 'finalizing')
  `)
    .bind(input.taskId, input.attemptId)
    .run();

  if (!claim.meta.changes) {
    const task = await env.db.prepare(
      `SELECT status, current_attempt_id, cancel_requested, error_code, final_content_path, content_commit_sha
       FROM tasks WHERE id = ?`,
    )
      .bind(input.taskId)
      .first<FinalizeTaskRow>();
    if (!task) throw new FinalizeError("task_not_found", "Task not found", false);
    // 幂等：本任务已成稿（例如 step 重放），直接返回既有结果。
    if (task.status === "success" && task.final_content_path) {
      return { finalPath: task.final_content_path, commitSha: task.content_commit_sha ?? "" };
    }
    if (task.current_attempt_id !== input.attemptId) {
      throw new FinalizeError("stale_attempt", "Completion is from a superseded attempt", false);
    }
    if (task.cancel_requested || task.status === "cancelled") {
      throw new FinalizeError("cancelled", "Task was cancelled; completion rejected", false);
    }
    throw new FinalizeError("not_running", `Task is not in a completable state (status=${task.status})`, false);
  }

  const task = await env.db.prepare(
    "SELECT episode_id, episode_title, podcast_name FROM tasks WHERE id = ?",
  )
    .bind(input.taskId)
    .first<{ episode_id: string | null; episode_title: string; podcast_name: string }>();
  if (!task) throw new FinalizeError("task_not_found", "Task not found", false);

  // 顺序不可颠倒：先发布成稿到 Store（幂等），成功后才标记 D1 success 并建立成稿索引。原始转录不入 Store。
  try {
    const published = await env.manuscripts.publish({
      writingFilename: input.writingFilename,
      title: task.episode_title,
      markdown,
    });
    const saved = { finalPath: published.path, commitSha: published.version };

    const taskUpdateStmt = env.db.prepare(`UPDATE tasks SET status = 'success', progress = 100, message = '已完成',
      final_content_path = ?, content_commit_sha = ?, transcript_source = 'ai_refined', refinement_success = 1,
      cancel_requested = 0, error_code = NULL,
      completed_at = ${NOW}, updated_at = ${NOW}
      WHERE id = ? AND current_attempt_id = ? AND status = 'finalizing'`)
      .bind(saved.finalPath, saved.commitSha, input.taskId, input.attemptId);

    const articleUpsertStmt = task.episode_id
      ? env.db.prepare(`INSERT INTO articles (task_id, episode_id, title, podcast_name, content_path, commit_sha)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(episode_id) WHERE episode_id IS NOT NULL DO UPDATE SET
            task_id = excluded.task_id,
            title = excluded.title,
            podcast_name = excluded.podcast_name,
            content_path = excluded.content_path,
            commit_sha = excluded.commit_sha,
            updated_at = ${NOW}`)
          .bind(input.taskId, task.episode_id, task.episode_title, task.podcast_name, saved.finalPath, saved.commitSha)
      : env.db.prepare(`INSERT INTO articles (task_id, episode_id, title, podcast_name, content_path, commit_sha)
          VALUES (?, NULL, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            title = excluded.title,
            podcast_name = excluded.podcast_name,
            content_path = excluded.content_path,
            commit_sha = excluded.commit_sha,
            updated_at = ${NOW}`)
          .bind(input.taskId, task.episode_title, task.podcast_name, saved.finalPath, saved.commitSha);

    // D1 原子事务提交：任务更新与成稿建立同生共死
    const [updateRes] = await env.db.batch([taskUpdateStmt, articleUpsertStmt]);

    if (!updateRes?.meta?.changes) {
      await env.db.prepare("DELETE FROM articles WHERE task_id = ?").bind(input.taskId).run();
      throw new FinalizeError("stale_attempt", "Task state changed during finalization; completion discarded", false);
    }
    return saved;
  } catch (caught) {
    if (caught instanceof FinalizeError) throw caught;
    console.error("Failed to persist completed podcast:", caught);
    // 保持 status = finalizing，抛 retryable error，由 publish step durable retry 直接重试！
    // 不在此处人工释放 claim 或覆写为 error；重试耗尽后由 Workflow 外层统一收敛为 error。
    throw new FinalizeError("final_persist_failed", "Failed to persist final article or task state", true);
  }
}
