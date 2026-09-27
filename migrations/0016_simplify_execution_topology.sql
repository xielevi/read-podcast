-- 0016: 简化 Cloudflare 内部执行拓扑（删除重复状态、重复锁与 shadow 字段）。
--
-- 架构收敛原则：
--   * D1       = user-visible durable business record
--   * Workflow = execution owner + durable step checkpoints
--   * R2       = large payload / retry checkpoint
--   * GitHub   = canonical final manuscript store
--
-- 列删除：
--   * workflow_id：Workflow 实例 ID 纯由 processingWorkflowId(task_id, attempt_id) 确定性推导，不再在 D1 重复记录。
--   * completion_claimed + finalization_owner：成稿阶段收敛为正式持久状态 status = 'finalizing'，
--     不再需要应用层双重锁与独立的所有者跟踪。
--
-- 状态枚举：
--   * 新增 'finalizing' 到 tasks.status CHECK 约束。
--   * 迁移时已有 completion_claimed = 1 且非终态的任务转为 status = 'finalizing'。
--
-- 索引：
--   * 重建 idx_tasks_active_episode 唯一索引，纳入 'finalizing'。

PRAGMA defer_foreign_keys = true;

CREATE TABLE _articles_keep AS SELECT * FROM articles;

CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('rss', 'upload')),
  podcast_name TEXT NOT NULL DEFAULT '',
  episode_title TEXT NOT NULL,
  audio_url TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'transcribing', 'refining', 'finalizing',
    'success', 'error', 'cancelled'
  )),
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  message TEXT NOT NULL DEFAULT '',
  raw_content_path TEXT,
  final_content_path TEXT,
  content_commit_sha TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  transcript_source TEXT,
  refinement_success INTEGER NOT NULL DEFAULT 0,
  current_attempt_id TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  custom_prompt TEXT,
  raw_object_key TEXT,
  refinement_started_at TEXT,
  provider_request_id TEXT,
  transcription_phase TEXT CHECK(transcription_phase IS NULL OR transcription_phase IN ('fetching', 'preparing', 'transcribing'))
);

INSERT INTO tasks_new (
  id, episode_id, source_type, podcast_name, episode_title, audio_url,
  status, progress, message, raw_content_path, final_content_path, content_commit_sha, error_code,
  created_at, updated_at, completed_at, transcript_source, refinement_success,
  current_attempt_id, cancel_requested, custom_prompt,
  raw_object_key, refinement_started_at,
  provider_request_id, transcription_phase
)
SELECT
  id, episode_id, source_type, podcast_name, episode_title, audio_url,
  CASE
    WHEN completion_claimed = 1 AND status NOT IN ('success', 'error', 'cancelled') THEN 'finalizing'
    ELSE status
  END,
  progress,
  message,
  raw_content_path, final_content_path, content_commit_sha,
  error_code,
  created_at,
  updated_at,
  completed_at,
  transcript_source, refinement_success,
  current_attempt_id,
  cancel_requested,
  custom_prompt,
  raw_object_key,
  refinement_started_at,
  provider_request_id,
  transcription_phase
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

INSERT OR IGNORE INTO articles SELECT * FROM _articles_keep;
DROP TABLE _articles_keep;

CREATE INDEX idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX idx_tasks_status ON tasks(status, created_at);
-- 双击/并发防护：同一 episode 在活跃态下最多一个任务（queued / transcribing / refining / finalizing）。
CREATE UNIQUE INDEX idx_tasks_active_episode
  ON tasks(episode_id)
  WHERE status IN ('queued', 'transcribing', 'refining', 'finalizing');
