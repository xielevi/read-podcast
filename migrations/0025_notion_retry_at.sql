-- 0025: Notion 待同步重试游标。
-- 失败或跳过的行写入 notion_retry_at，定时任务按「未尝试优先，其次最久未试」取下一批，
-- 避免同一批永久失败的稿件占满 LIMIT。成功后清回 NULL。
ALTER TABLE articles ADD COLUMN notion_retry_at TEXT;

CREATE INDEX IF NOT EXISTS idx_articles_notion_retry_at ON articles(notion_sync_pending, notion_retry_at);
