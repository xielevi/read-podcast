-- 0015: Cloudflare 拥有完整任务生命周期（转录也由 Cloudflare 编排）。
--
-- 状态枚举：waiting_worker / downloading / transcribing / refining / success / error / cancelled
--        →  queued          / transcribing / refining / success / error / cancelled
--   * waiting_worker → queued：任务已由 Cloudflare 接收并排队，不再「等待某个 worker」。
--   * downloading    → transcribing：取音频现在是转录服务内部的子阶段，由 transcription_phase 反映。
--
-- 列变化：
--   * refine_workflow_id → workflow_id：唯一的 Processing Workflow 实例 id，任务创建时即建立。
--   * + provider_request_id：当前 attempt 在转录服务上的请求句柄（仅用于轮询 / 取消，不是业务 id）。
--   * + transcription_phase：转录服务上报的子阶段镜像（fetching / preparing / transcribing）。
--
-- SQLite 无法修改 CHECK 约束，只能重建 tasks。articles.task_id 以 ON DELETE CASCADE 引用 tasks，
-- 而 DROP TABLE 会先隐式 DELETE 父表行并触发级联——因此先把 articles 整表暂存，重建后再恢复，
-- 已成稿的文章不会丢失（无论运行环境是否开启 foreign_keys 都成立：恢复使用 INSERT OR IGNORE）。
--
-- 升级时的 active task（保证不留下永久 zombie）：
--   * 转录阶段（waiting_worker / downloading / transcribing，无论 raw 是否已落 R2）→ queued，
--     轮换 attempt、清空 workflow / provider 句柄；Processing Workflow 启动后先探测 raw：
--     raw 已在 R2 → 直接进入精修，不重新转录；否则由 Cloudflare 重新提交转录。
--     该任务若已有挂起的取消意图（cancel_requested = 1），直接收敛为 cancelled。
--   * 精修阶段（refining，旧 RefineWorkflow 实例在新代码下不再存在）→ queued，同样轮换 attempt；
--     raw 仍在 R2，新 Workflow 只重跑精修，不重新转录。
--   * completion_claimed = 1（成稿提交中）保持原样：僵尸 claim 由 Cloudflare 的 stale-claim
--     sweep 在 10 分钟后收敛为可重试的 error(final_persist_failed)，已提交的稿件内容幂等。
--   * success / error / cancelled 原样保留（error 与 cancelled 仍可 retry）。
-- 升级后由 Cloudflare 的 recovery sweep（cron / 任务列表轮询）为 queued 且尚无 workflow_id 的任务启动 Workflow。

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
    'queued', 'transcribing', 'refining',
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
  completion_claimed INTEGER NOT NULL DEFAULT 0,
  custom_prompt TEXT,
  raw_object_key TEXT,
  workflow_id TEXT,
  refinement_started_at TEXT,
  finalization_owner TEXT,
  provider_request_id TEXT,
  transcription_phase TEXT CHECK(transcription_phase IS NULL OR transcription_phase IN ('fetching', 'preparing', 'transcribing'))
);

-- 「需要重新排队」：非终态、未进入成稿提交、且没有被取消。
INSERT INTO tasks_new (
  id, episode_id, source_type, podcast_name, episode_title, audio_url,
  status, progress, message, raw_content_path, final_content_path, content_commit_sha, error_code,
  created_at, updated_at, completed_at, transcript_source, refinement_success,
  current_attempt_id, cancel_requested, completion_claimed, custom_prompt,
  raw_object_key, workflow_id, refinement_started_at, finalization_owner,
  provider_request_id, transcription_phase
)
SELECT
  id, episode_id, source_type, podcast_name, episode_title, audio_url,
  CASE
    WHEN status IN ('waiting_worker', 'downloading', 'transcribing', 'refining') AND completion_claimed = 0 AND cancel_requested = 1 THEN 'cancelled'
    WHEN status IN ('waiting_worker', 'downloading', 'transcribing', 'refining') AND completion_claimed = 0 THEN 'queued'
    WHEN status = 'waiting_worker' THEN 'queued'
    WHEN status = 'downloading' THEN 'transcribing'
    ELSE status
  END,
  CASE
    WHEN status IN ('waiting_worker', 'downloading', 'transcribing', 'refining') AND completion_claimed = 0 THEN 0
    ELSE progress
  END,
  CASE
    WHEN status IN ('waiting_worker', 'downloading', 'transcribing', 'refining') AND completion_claimed = 0 AND cancel_requested = 1 THEN '任务已取消'
    WHEN status IN ('waiting_worker', 'downloading', 'transcribing', 'refining') AND completion_claimed = 0 THEN '系统升级：已重新排队，由 Cloudflare 继续调度'
    ELSE message
  END,
  raw_content_path, final_content_path, content_commit_sha,
  CASE
    WHEN status IN ('waiting_worker', 'downloading', 'transcribing', 'refining') AND completion_claimed = 0 THEN NULL
    ELSE error_code
  END,
  created_at,
  CASE
    WHEN status IN ('waiting_worker', 'downloading', 'transcribing', 'refining') AND completion_claimed = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ELSE updated_at
  END,
  CASE
    WHEN status IN ('waiting_worker', 'downloading', 'transcribing', 'refining') AND completion_claimed = 0 AND cancel_requested = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ELSE completed_at
  END,
  transcript_source, refinement_success,
  CASE
    WHEN status IN ('waiting_worker', 'downloading', 'transcribing', 'refining') AND completion_claimed = 0 AND cancel_requested = 0 THEN lower(hex(randomblob(16)))
    ELSE current_attempt_id
  END,
  cancel_requested, completion_claimed, custom_prompt,
  raw_object_key,
  CASE
    WHEN status IN ('waiting_worker', 'downloading', 'transcribing', 'refining') AND completion_claimed = 0 THEN NULL
    ELSE refine_workflow_id
  END,
  CASE
    WHEN status IN ('waiting_worker', 'downloading', 'transcribing', 'refining') AND completion_claimed = 0 THEN NULL
    ELSE refinement_started_at
  END,
  finalization_owner,
  NULL,
  NULL
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

INSERT OR IGNORE INTO articles SELECT * FROM _articles_keep;
DROP TABLE _articles_keep;

CREATE INDEX idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX idx_tasks_status ON tasks(status, created_at);
-- 双击/并发防护：同一 episode 在活跃态下最多一个任务（自定义上传 episode_id 为 NULL，互不冲突）。
CREATE UNIQUE INDEX idx_tasks_active_episode
  ON tasks(episode_id)
  WHERE status IN ('queued', 'transcribing', 'refining');
