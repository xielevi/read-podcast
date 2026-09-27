-- 执行 attempt 与取消意图（可靠性：拒绝迟到/旧 attempt 回调，取消不被复活）。
-- current_attempt_id：当前有效执行；所有 Mac 回调必须匹配它，否则视为 stale 丢弃。
-- cancel_requested：用户已请求取消；complete 一律不得越过它写 GitHub。
ALTER TABLE tasks ADD COLUMN current_attempt_id TEXT;
ALTER TABLE tasks ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
