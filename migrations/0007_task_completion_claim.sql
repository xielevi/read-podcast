-- 终态提交界限（可靠性：Complete 与 Cancel 的 finalization boundary）。
-- completion_claimed：Complete 在开始 GitHub commit 前原子置为 1；
-- 一旦置为 1，任务不可取消；Cancel 请求原子失败并返回 409 finalizing。
-- 若 Cancel 先将 cancel_requested 置为 1，Complete 原子 claim 失败，不调用 GitHub。
ALTER TABLE tasks ADD COLUMN completion_claimed INTEGER NOT NULL DEFAULT 0;
