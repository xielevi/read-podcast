/**
 * Processing Workflow 各阶段共享的类型与小工具（转录阶段 / 精修阶段都依赖，独立成模块避免循环引用）。
 */
import { NonRetryableError } from "cloudflare:workflows";
import type { RefinerConfigSnapshot } from "../refinement/refiner";
import type { TaskRow } from "../db";
import type { Env } from "../types";

/** Workflow event 只传 metadata：raw transcript 绝不进入 event / step 返回值（R2 才是 raw SSOT）。 */
export interface ProcessingWorkflowParams {
  taskId: string;
  attemptId: string;
  config: RefinerConfigSnapshot;
}

// ── Workflow step 的最小结构化接口（生产实现由 workerd 的 WorkflowStep 满足；测试用内存实现） ──

export interface StepContextLike {
  attempt: number;
  step: { name: string; count: number };
}

export type DelayFunction = (input: { ctx: StepContextLike; error: Error }) => number | string;

export interface StepConfigLike {
  retries?: { limit: number; delay: number | string | DelayFunction; backoff?: "constant" | "linear" | "exponential" };
  timeout?: number | string;
}

export interface WorkflowStepLike {
  do<T>(name: string, config: StepConfigLike, callback: (ctx: StepContextLike) => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
}


/**
 * 让 Workflow 引擎立即终止 step 的错误（不再重试）。
 *
 * 引擎按 `error.name === "NonRetryableError" || message.startsWith("NonRetryableError")` 识别它，
 * 因此**绝不能**把 code 塞进构造函数的第二个参数（那会覆盖 name，引擎就会把它当普通错误一路重试到耗尽）。
 * 稳定的错误码放在消息前缀 `[code]` 里：错误穿过 step 边界后自定义属性会丢失，但消息（含前缀）保留，
 * 见 pipeline.errorCodeOf。
 */
export function nonRetryable(code: string, message: string): NonRetryableError {
  const error = new NonRetryableError(`[${code}] ${message}`);
  (error as Error & { code?: string }).code = code;
  return error;
}

/**
 * 把领域错误（转录服务 / 精修服务商 / 成稿持久化）翻译成 step 错误的唯一入口：
 * 不可重试 → nonRetryable；可重试 → 普通 Error 交给 durable retry。两者消息都带 `[code]` 前缀
 * （穿过 step 边界后仍可归因），`retryAfterSeconds` 留给 exponentialRetryDelay 使用。
 */
export function workflowError(code: string, message: string, options: { retryable: boolean; retryAfterSeconds?: number }): Error {
  if (!options.retryable) return nonRetryable(code, message);
  const error = new Error(`[${code}] ${message}`) as Error & { code?: string; retryAfterSeconds?: number };
  error.code = code;
  if (options.retryAfterSeconds !== undefined) error.retryAfterSeconds = options.retryAfterSeconds;
  return error;
}

/**
 * durable retry 的延迟策略：优先服务端 Retry-After，否则指数退避（10s / 20s / 40s … 封顶 5 分钟）。
 * 不使用进程内 sleep 模拟 durable retry。
 */
export const exponentialRetryDelay: DelayFunction = ({ ctx, error }) => {
  const retryAfter = (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    return `${Math.min(Math.round(retryAfter), 900)} seconds`;
  }
  const attempt = Math.max(1, Number(ctx?.attempt ?? 1));
  const seconds = Math.min(300, 10 * 2 ** Math.min(attempt - 1, 6));
  return `${seconds} seconds`;
};


/**
 * 最小的所有权判定：任务存在、仍是本 attempt、未被取消。不看其余状态——refine / publish 在
 * refining、finalizing（publish 重放）乃至 success（幂等返回）时都必须能继续走到自己的 CAS。
 */
export function assertAttemptCurrent(task: TaskRow | null, attemptId: string): TaskRow {
  if (!task) throw nonRetryable("task_not_found", "Task not found");
  if (task.current_attempt_id !== attemptId) throw nonRetryable("stale_attempt", "Attempt superseded");
  if (task.cancel_requested || task.status === "cancelled") throw nonRetryable("cancelled", "Task was cancelled");
  return task;
}

/**
 * step 内的统一「任务仍归本 attempt」判定：把 D1 的当前事实翻译成 NonRetryable。
 * 取消 / 过期 attempt / 已终态都不允许 Workflow 继续做任何有副作用的事。
 */
export function assertTaskOwned(task: TaskRow | null, attemptId: string): TaskRow {
  const owned = assertAttemptCurrent(task, attemptId);
  if (owned.status === "finalizing") throw nonRetryable("already_finalizing", "Task is already finalizing");
  if (owned.status === "success") throw nonRetryable("already_success", "Task already succeeded");
  if (owned.status === "error") throw nonRetryable("terminal", "Task is in terminal state: error");
  return owned;
}
