/**
 * ProcessingWorkflow —— Cloudflare 的 durable 业务编排体（从任务创建到成稿，含转录）。
 *
 * 责任边界：本 Workflow 是整条任务生命周期的唯一执行体。转录服务只是它调用的外部计算；
 * 精修 / 质量门禁 / Formatter / GitHub 入库 / D1 success 也都在这里，全程只依赖 Cloudflare 自己的
 * 状态（D1 / R2）——raw 落 R2 之后转录服务关机、下线、被替换都不影响任务继续。
 *
 * 实例 ID 确定性：process-<task_id>-<attempt_id>（81 字符，低于 Workflows 100 字符限制）。
 * 因此任务创建 / retry / recovery sweep 对同一 (task, attempt) 的重复启动是幂等的：
 * 永远不会出现第二个并行 Workflow。
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { REFINE_ERROR_RETENTION, REFINE_SUCCESS_RETENTION } from "../refinement/defaults";
import { snapshotOf, loadRefinerSettings } from "../refinement/settings";
import { type ProcessingWorkflowParams, type WorkflowStepLike } from "./common";
import { runProcessingPipeline } from "./pipeline";
import type { Env } from "../types";

export class ProcessingWorkflow extends WorkflowEntrypoint<Env, ProcessingWorkflowParams> {
  async run(event: WorkflowEvent<ProcessingWorkflowParams>, step: WorkflowStep): Promise<unknown> {
    return runProcessingPipeline(this.env, event.payload, event.instanceId, step as unknown as WorkflowStepLike);
  }
}

export function processingWorkflowId(taskId: string, attemptId: string): string {
  return `process-${taskId}-${attemptId}`;
}

/** 实例是否已存在（get + status；不存在时任一调用抛错）。 */
async function instanceExists(env: Env, id: string): Promise<boolean> {
  try {
    const instance = await env.PROCESSING_WORKFLOW.get(id);
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

  try {
    await env.PROCESSING_WORKFLOW.create({
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
 * 不在 D1 记录 workflow 实例 ID（纯由 taskId + attemptId 确定性推导）。
 */
export async function startProcessingWorkflow(env: Env, taskId: string, attemptId: string): Promise<string> {
  const params = await buildProcessingParams(env, taskId, attemptId);
  return ensureProcessingWorkflow(env, params);
}

/** 取消：terminate 当前 Workflow instance（由 taskId + attemptId 推导）。 */
export async function terminateProcessingWorkflow(env: Env, taskId: string, attemptId: string): Promise<void> {
  const id = processingWorkflowId(taskId, attemptId);
  try {
    const instance = await env.PROCESSING_WORKFLOW.get(id);
    await instance.terminate();
  } catch (error) {
    // 已经终止 / 从未创建 / retention 已过期的实例都视为已终止
    console.warn(`terminateProcessingWorkflow(${id}) skipped:`, error instanceof Error ? error.message : error);
  }
}

/** Workflow 实例状态（仅供 liveness 对账）；实例不存在 / 查询失败 → null。 */
export async function processingWorkflowStatus(env: Env, workflowId: string): Promise<string | null> {
  try {
    const instance = await env.PROCESSING_WORKFLOW.get(workflowId);
    const { status } = await instance.status();
    return String(status);
  } catch {
    return null;
  }
}
