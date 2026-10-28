-- 0024: Notion 稿件同步状态。
-- notion_sync_pending = 1 只表示「R2 快照已写入、Notion 页仍需定时任务重试」。
-- 历史 GitHub / 本地稿件保持默认 0，定时任务不会把它们当成待导入。
-- notion_synced_at：该快照已写入 Notion 的时间；未同步或非 Notion 部署为 NULL。
ALTER TABLE articles ADD COLUMN notion_sync_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE articles ADD COLUMN notion_synced_at TEXT;

CREATE INDEX IF NOT EXISTS idx_articles_notion_sync_pending ON articles(notion_sync_pending);
