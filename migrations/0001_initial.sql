PRAGMA foreign_keys = ON;

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  rss_url TEXT NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE,
  podcast_name TEXT NOT NULL,
  title TEXT NOT NULL,
  audio_url TEXT NOT NULL,
  published_at TEXT,
  duration_seconds INTEGER,
  artwork_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_episodes_published ON episodes(published_at DESC);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('rss', 'upload')),
  podcast_name TEXT NOT NULL DEFAULT '',
  episode_title TEXT NOT NULL,
  audio_url TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'waiting_worker', 'downloading', 'transcribing', 'refining',
    'success', 'error', 'cancelled'
  )),
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  message TEXT NOT NULL DEFAULT '',
  raw_content_path TEXT,
  final_content_path TEXT,
  content_commit_sha TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT
);
CREATE INDEX idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX idx_tasks_status ON tasks(status, created_at);

CREATE TABLE read_state (
  episode_id TEXT PRIMARY KEY,
  read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE articles (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  podcast_name TEXT NOT NULL DEFAULT '',
  content_path TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
