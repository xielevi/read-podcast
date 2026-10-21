-- 0023: 稿件导读（Article Brief）。
-- articles.brief：发布时由 ProcessingWorkflow generate-brief step 生成的导读 JSON
-- （version / tldr / key_points / quotes / audience / sections / reading_minutes，见 src/refinement/brief.ts）。
-- 可空：导读是尽力而为的，生成失败或历史稿件为 NULL。与 article upsert 同一 batch 写入。
ALTER TABLE articles ADD COLUMN brief TEXT DEFAULT NULL;
