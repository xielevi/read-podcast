-- 补齐 RSS 语义字段：Formatter 需要 published/duration/link，任务解析需要 summary（计划 §7）。
ALTER TABLE episodes ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE episodes ADD COLUMN link TEXT NOT NULL DEFAULT '';
ALTER TABLE episodes ADD COLUMN published TEXT NOT NULL DEFAULT '';   -- RSS pubDate 原文
ALTER TABLE episodes ADD COLUMN published_date TEXT NOT NULL DEFAULT '';  -- YYYYMMDD，供 build_filename_base
ALTER TABLE episodes ADD COLUMN duration TEXT NOT NULL DEFAULT '';    -- itunes:duration 原文
ALTER TABLE episodes ADD COLUMN updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE INDEX IF NOT EXISTS idx_episodes_podcast ON episodes(podcast_name, published_date DESC);

-- 订阅级 RSS 拉取时间戳，实现 SWR（新鲜直接返回 D1，过期触发刷新）。
ALTER TABLE subscriptions ADD COLUMN episodes_synced_at TEXT NOT NULL DEFAULT '';
