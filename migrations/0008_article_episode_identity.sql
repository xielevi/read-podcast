-- 建立 Article 的稳定内容标识 episode_id，并保证一个 episode 仅保留一篇当前最新成稿。
ALTER TABLE articles ADD COLUMN episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL;

-- 为历史已生成的 articles 回填关联的 episode_id
UPDATE articles
SET episode_id = (SELECT episode_id FROM tasks WHERE tasks.id = articles.task_id)
WHERE episode_id IS NULL;

-- 若存在历史重复执行产生的同一 episode 稿件，只保留最新的一篇
DELETE FROM articles
WHERE episode_id IS NOT NULL
  AND task_id NOT IN (
    SELECT task_id FROM (
      SELECT task_id, ROW_NUMBER() OVER (PARTITION BY episode_id ORDER BY updated_at DESC, created_at DESC) AS rn
      FROM articles WHERE episode_id IS NOT NULL
    ) WHERE rn = 1
  );

-- 部分唯一索引：RSS 单集在 articles 中具有唯一性（force rerun 覆盖更新指向最新 task）
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_episode_id
  ON articles(episode_id)
  WHERE episode_id IS NOT NULL;
