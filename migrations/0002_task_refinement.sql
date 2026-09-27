-- 记录精修结果来源，供稿件库/调试区分 AI 精修稿与原始转录回退稿（计划 §12）。
ALTER TABLE tasks ADD COLUMN transcript_source TEXT;
ALTER TABLE tasks ADD COLUMN refinement_success INTEGER NOT NULL DEFAULT 0;
