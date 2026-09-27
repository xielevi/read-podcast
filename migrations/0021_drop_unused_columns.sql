-- 删除代码早已不读写的列（与索引）：
--   * episodes.published_at：与 published_date 同值的重复列，其索引 idx_episodes_published 也没有查询使用；
--   * episodes.artwork_url：从 0001 起从未写入；
--   * tasks.raw_content_path：raw 早已只存 R2（raw_object_key），此列不再写入。
-- tasks.transcript_source / refinement_success 仍保留：scripts/audit_suspicious_articles.sh 依赖它们做历史审计。
DROP INDEX IF EXISTS idx_episodes_published;
ALTER TABLE episodes DROP COLUMN published_at;
ALTER TABLE episodes DROP COLUMN artwork_url;
ALTER TABLE tasks DROP COLUMN raw_content_path;
