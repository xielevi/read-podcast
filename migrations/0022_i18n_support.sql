-- 0022: 中英双语支持（UI locale、稿件 content_language 与多语言维基概念缓存）。
-- 1. ui_preferences 增加 locale 列（zh | en，可空，未显式设置时不覆盖浏览器自适应）；
-- 2. tasks 增加 content_language 列（zh | en，记录任务内容语言）；
-- 3. article_concepts 增加 lang 列并调整主键为 (content_path, commit_sha, lang)。

ALTER TABLE ui_preferences ADD COLUMN locale TEXT DEFAULT NULL CHECK (locale IS NULL OR locale IN ('zh', 'en'));

ALTER TABLE tasks ADD COLUMN content_language TEXT DEFAULT NULL CHECK (content_language IS NULL OR content_language IN ('zh', 'en'));

CREATE TABLE article_concepts_new (
  content_path TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'zh' CHECK (lang IN ('zh', 'en')),
  concepts_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (content_path, commit_sha, lang)
);

INSERT OR IGNORE INTO article_concepts_new (content_path, commit_sha, lang, concepts_json, created_at)
SELECT content_path, commit_sha, 'zh', concepts_json, created_at FROM article_concepts;

DROP TABLE article_concepts;
ALTER TABLE article_concepts_new RENAME TO article_concepts;
CREATE INDEX idx_article_concepts_created ON article_concepts(created_at DESC);
