-- 0014: finalization ownership（durable-execution 收口）。
-- finalization_owner：当前持有 finalization claim 的 Workflow instance id。
-- 同一 Workflow 的 step replay（isolate 崩溃 / 引擎重放）凭 owner 重新进入
-- finalization 并续跑；不同 owner（另一 Workflow / 旧 attempt）被拒绝。
-- 成功或失败释放时一并清 NULL，绝不残留跨 attempt 的僵尸 owner。
ALTER TABLE tasks ADD COLUMN finalization_owner TEXT;
