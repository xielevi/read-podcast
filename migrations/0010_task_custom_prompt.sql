-- 记录自定义任务的精修 Prompt 或模板说明，供 retry 对账复用。
ALTER TABLE tasks ADD COLUMN custom_prompt TEXT;
