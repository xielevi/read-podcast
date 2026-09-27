/**
 * ProcessingWorkflow 业务编排助手（确定性 instance id、参数快照、工作流生命周期调用）。
 *
 * 平台中立：通过 Env.workflows 接口驱动工作流引擎，不直接依赖 Cloudflare 绑定。
 * Cloudflare 具体的 WorkflowEntrypoint 入口移至平台适配层（src/platform/cloudflare.ts）。
 */
import { REFINE_ERROR_RETENTION, REFINE_SUCCESS_RETENTION } from "../refinement/defaults";
import { snapshotOf, loadRefinerSettings } from "../refinement/settings";
import type { ProcessingWorkflowParams } from "./common";
import type { Env } from "../types";

export function processingWorkflowId(taskId: string, attemptId: string): string {
  return `process-${taskId}-${attemptId}`;
}

/** 实例是否已存在（get + status；不存在时任一调用抛错）。 */
async function instanceExists(env: Env, id: string): Promise<boolean> {
  if (!env.workflows) return false;
  try {
    const instance = await env.workflows.get(id);
    await instance.status();
    return true;
  } catch {
    return false;
  }
}

/** Workflow 创建时采样当前 refiner 配置：任务中途不随 D1 配置漂移。 */
export async function buildProcessingParams(env: Env, taskId: string, attemptId: string): Promise<ProcessingWorkflowParams> {
  const settings = await loadRefinerSettings(env);
  return { taskId, attemptId, config: snapshotOf(settings) };
}

/**
 * 确保 Processing Workflow instance 已存在（幂等）。
 * - 已存在（含并发创建竞态）→ 视为成功，绝不创建第二个 Workflow；
 * - 不存在 → create，并收紧 retention（success 1 day / error 3 days）。
 */
export async function ensureProcessingWorkflow(env: Env, params: ProcessingWorkflowParams): Promise<string> {
  const id = processingWorkflowId(params.taskId, params.attemptId);
  if (await instanceExists(env, id)) return id;

  if (!env.workflows) {
    throw new Error("Task workflows engine not configured in platform environment");
  }

  try {
    await env.workflows.create({
      id,
      params,
      retention: { successRetention: REFINE_SUCCESS_RETENTION, errorRetention: REFINE_ERROR_RETENTION },
    });
  } catch (error) {
    if (await instanceExists(env, id)) return id;
    throw error;
  }
  return id;
}

/**
 * 为一个 (task, attempt) 启动 Processing Workflow（确定性 instance id）。
 * 幂等：重复调用（创建请求重试 / recovery sweep / retry）都收敛到同一个实例。
 * 不在数据库记录 workflow 实例 ID（纯由 taskId + attemptId 确定性推导）。
 */
export async function startProcessingWorkflow(env: Env, taskId: string, attemptId: string): Promise<string> {
  const params = await buildProcessingParams(env, taskId, attemptId);
  return ensureProcessingWorkflow(env, params);
}

/** 取消：terminate 当前 Workflow instance（由 taskId + attemptId 推导）。 */
export async function terminateProcessingWorkflow(env: Env, taskId: string, attemptId: string): Promise<void> {
  if (!env.workflows) return;
  const id = processingWorkflowId(taskId, attemptId);
  try {
    const instance = await env.workflows.get(id);
    await instance.terminate();
  } catch (error) {
    // 已经终止 / 从未创建 / retention 已过期的实例都视为已终止
    console.warn(`terminateProcessingWorkflow(${id}) skipped:`, error instanceof Error ? error.message : error);
  }
}

/** Workflow 实例状态（仅供 liveness 对账）；实例不存在 / 查询失败 → null。 */
export async function processingWorkflowStatus(env: Env, workflowId: string): Promise<string | null> {
  if (!env.workflows) return null;
  try {
    const instance = await env.workflows.get(workflowId);
    const { status } = await instance.status();
    return String(status);
  } catch {
    return null;
  }
}
