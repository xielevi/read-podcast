-- 对齐原生已读语义：key 为 (podcast_name, episode_title)，兼容没有 D1 episode 行的
-- 历史稿件（计划 §7/§PARITY §6）。read key 对外表示为 "podcast_name::episode_title"。
DROP TABLE IF EXISTS read_state;

CREATE TABLE read_state (
  podcast_name TEXT NOT NULL,
  episode_title TEXT NOT NULL,
  read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (podcast_name, episode_title)
);
CREATE INDEX idx_read_state_read_at ON read_state(read_at DESC);
