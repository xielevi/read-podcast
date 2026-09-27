-- 0013: Edge 侧精修运行时配置（typed single-row table）。
-- 职责互斥：本表 = Cloudflare 文本管线运行时配置；
-- repo 源码 = 默认 Prompt 与算法配置；Wrangler Secret = REFINER_API_KEY（绝不入表）。
CREATE TABLE IF NOT EXISTS refiner_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_base TEXT NOT NULL,
  model TEXT NOT NULL,
  temperature REAL NOT NULL DEFAULT 0.3,
  max_tokens INTEGER NOT NULL DEFAULT 65536,
  min_output_ratio REAL NOT NULL DEFAULT 0.9,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 迁移时的现有生产配置（OpenCode Go）。
INSERT OR IGNORE INTO refiner_settings (id, api_base, model, temperature, max_tokens, min_output_ratio)
VALUES (1, 'https://opencode.ai/zen/go/v1', 'deepseek-v4.1-flash', 0.3, 65536, 0.9);
