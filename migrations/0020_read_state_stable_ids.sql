-- 已读状态改按稿件的稳定身份记，不再按「节目名 + 标题」（节目改名 / 标题修订后已读会丢）：
--   * RSS 单集：episode_id（重新生成稿件也不变）；
--   * 导入音频（没有单集）：稿件的 task_id。
-- 两列恰好一个有值。旧行按「节目名 + 标题」对上稿件或单集后迁入；对不上的（单集已随订阅删除等）丢弃。
CREATE TABLE read_state_new (
  episode_id TEXT UNIQUE,
  task_id TEXT UNIQUE,
  read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((episode_id IS NULL) <> (task_id IS NULL))
);

INSERT OR IGNORE INTO read_state_new (episode_id, task_id, read_at)
SELECT
  COALESCE(a.episode_id, e.id),
  CASE WHEN COALESCE(a.episode_id, e.id) IS NULL THEN a.task_id END,
  r.read_at
FROM read_state r
LEFT JOIN articles a ON a.podcast_name = r.podcast_name AND a.title = r.episode_title
LEFT JOIN episodes e ON e.podcast_name = r.podcast_name AND e.title = r.episode_title
WHERE COALESCE(a.episode_id, e.id, a.task_id) IS NOT NULL;

DROP TABLE read_state;
ALTER TABLE read_state_new RENAME TO read_state;
CREATE INDEX idx_read_state_read_at ON read_state(read_at DESC);
