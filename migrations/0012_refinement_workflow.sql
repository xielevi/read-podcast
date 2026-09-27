-- 0012: Refine Workflow 交接字段。
-- raw_object_key  : 当前 attempt 已成功交付 Cloudflare 的 R2 原始转录对象键（Mac → Edge ownership handoff 凭证）。
-- refine_workflow_id: 当前 Refinement Workflow 实例 ID（确定性 ID：refine-<task_id>-<attempt_id>）。
-- refinement_started_at: 进入 refining 的时间，仅供调试与运维观察，不作为状态机正确性依赖。
ALTER TABLE tasks ADD COLUMN raw_object_key TEXT;
ALTER TABLE tasks ADD COLUMN refine_workflow_id TEXT;
ALTER TABLE tasks ADD COLUMN refinement_started_at TEXT;
