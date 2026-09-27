-- 单集列表服务端分页（GET …/episodes/page）所需的索引：
--   * articles(podcast_name, title)：按「节目名 + 标题」关联历史稿件（每集一次索引查找，不扫描整张 articles）；
--   * episodes 时间线顺序（日期未知的排最后）：全部订阅的第一页只读 LIMIT 行，不对整张表排序。
CREATE INDEX IF NOT EXISTS idx_articles_podcast_title ON articles(podcast_name, title);
CREATE INDEX IF NOT EXISTS idx_episodes_timeline ON episodes((published_date GLOB '[0-9]*') DESC, published_date DESC, id);
