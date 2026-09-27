import type { Env, TaskStatus, TranscriptionPhase } from "./types";

/** D1 写入时间戳的唯一 SQL 表达式（UTC，毫秒精度，ISO 8601）。拼进 SQL 模板使用。 */
export const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * `tasks` 表的完整一行（`SELECT *`，与迁移 0021 后的 schema 一一对应；migrations 测试锁定两者一致）。
 * 任务 API 与 Processing Workflow 共用这一个形状；加列时改这里，不要再定义局部类型。
 */
export interface TaskRow {
  id: string;
  status: TaskStatus;
  source_type: "rss" | "upload";
  episode_id: string | null;
  podcast_name: string;
  episode_title: string;
  audio_url: string | null;
  custom_prompt: string | null;
  progress: number;
  message: string;
  current_attempt_id: string | null;
  cancel_requested: number;
  raw_object_key: string | null;
  provider_request_id: string | null;
  transcription_phase: TranscriptionPhase | null;
  refinement_started_at: string | null;
  error_code: string | null;
  final_content_path: string | null;
  content_commit_sha: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** 仅供 scripts/audit_suspicious_articles.sh 的历史审计；成稿时写入固定值。 */
  transcript_source: string | null;
  refinement_success: number;
  content_language: "zh" | "en" | null;
}

/** TaskRow 的列名（与 `tasks` 表 schema 对照用）。 */
export const TASK_COLUMNS: ReadonlyArray<keyof TaskRow> = [
  "id", "episode_id", "source_type", "podcast_name", "episode_title", "audio_url", "status", "progress", "message",
  "final_content_path", "content_commit_sha", "error_code", "created_at", "updated_at", "completed_at",
  "transcript_source", "refinement_success", "current_attempt_id", "cancel_requested", "custom_prompt",
  "raw_object_key", "refinement_started_at", "provider_request_id", "transcription_phase", "content_language",
];

export async function loadTaskRow(env: Env, taskId: string): Promise<TaskRow | null> {
  return env.db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<TaskRow>();
}
