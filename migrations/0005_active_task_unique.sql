-- 双击/并发防护（计划 §21）：同一 episode 在活跃态下最多一个任务。
-- 部分唯一索引让并发 INSERT 原子失败，由应用捕获后返回既有任务，而非穿透成两个执行。
-- NULL episode_id（自定义上传）互不冲突，符合 SQLite NULL 唯一语义。
CREATE UNIQUE INDEX idx_tasks_active_episode
  ON tasks(episode_id)
  WHERE status IN ('waiting_worker', 'downloading', 'transcribing', 'refining');
