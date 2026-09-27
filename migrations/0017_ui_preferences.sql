-- 0017: 云端 UI 与阅读偏好（typed single-row table）。
-- 职责互斥：本表 = 站长云端偏好设置（应用外观与阅读器主题、排版预设、字号、行距、版宽）；
-- 客户端本地零配置，以 D1 为单一真源（Single Source of Truth）。
CREATE TABLE IF NOT EXISTS ui_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_theme TEXT NOT NULL DEFAULT 'auto' CHECK (app_theme IN ('auto', 'light', 'dark')),
  reader_theme TEXT NOT NULL DEFAULT 'follow' CHECK (reader_theme IN ('follow', 'paper', 'warm', 'green', 'dark')),
  font_preset TEXT NOT NULL DEFAULT 'classical' CHECK (font_preset IN ('classical', 'modern')),
  font_size INTEGER NOT NULL DEFAULT 19 CHECK (font_size BETWEEN 12 AND 36),
  line_height TEXT NOT NULL DEFAULT 'normal' CHECK (line_height IN ('compact', 'normal', 'relaxed')),
  margin_width TEXT NOT NULL DEFAULT 'normal' CHECK (margin_width IN ('compact', 'normal', 'wide')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO ui_preferences (id, app_theme, reader_theme, font_preset, font_size, line_height, margin_width)
VALUES (1, 'auto', 'follow', 'classical', 19, 'normal', 'normal');
