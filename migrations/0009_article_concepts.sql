-- 关键概念缓存（D1 派生数据，绑定 content_commit_sha，避免重复消耗 AI Token）。
-- 相同 GitHub commit_sha 打开直接秒级命中缓存；force rerun 产生新 commit 时自动 miss 并重新抽取。
CREATE TABLE IF NOT EXISTS article_concepts (
  content_path TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  concepts_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (content_path, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_article_concepts_created ON article_concepts(created_at DESC);
