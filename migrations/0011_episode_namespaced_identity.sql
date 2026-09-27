-- 增加 source_id 记录单集在源 RSS 中的原始 GUID/link，建立 (subscription_id, source_id) 唯一索引。
-- 解决跨节目 GUID 冲突及同节目更新问题。
ALTER TABLE episodes ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
UPDATE episodes SET source_id = id WHERE source_id = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_subscription_source ON episodes(subscription_id, source_id);
