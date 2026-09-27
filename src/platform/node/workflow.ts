/**
 * 本地进程内任务工作流执行器：基于 SQLite 断点表持久化 step 输出与实例生命周期。
 * 语义与 Cloudflare Workflows 一致（重放幂等、NonRetryableError 拦截、断点续传、超时与重试退避）。
 */
import type { DatabaseSync } from "node:sqlite";
import {
  NonRetryableError,
  type StepConfigLike,
  type StepContextLike,
  type TaskWorkflowEngine,
  type TaskWorkflowInstance,
  type WorkflowStepLike,
} from "../types";

export type WorkflowHandler = (
  params: any,
  instanceId: string,
  step: WorkflowStepLike,
) => Promise<unknown>;

export function parseDuration(duration: string | number | undefined): number {
  if (typeof duration === "number") return duration;
  if (!duration) return 0;
  const str = String(duration).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/.exec(str);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2] ?? "ms";
  if (unit.startsWith("ms") || unit.startsWith("milli")) return val;
  if (unit.startsWith("s")) return val * 1000;
  if (unit.startsWith("m")) return val * 60 * 1000;
  if (unit.startsWith("h")) return val * 3600 * 1000;
  if (unit.startsWith("d")) return val * 86400 * 1000;
  return val;
}

export function isNonRetryableError(err: unknown): boolean {
  if (err instanceof NonRetryableError) return true;
  if (err instanceof Error) {
    if (err.name === "NonRetryableError" || err.message.startsWith("NonRetryableError")) return true;
    if ((err as any).code === "NonRetryableError") return true;
  }
  return false;
}

export interface LocalWorkflowEngineOptions {
  db: DatabaseSync;
  handler: WorkflowHandler;
}

export class LocalWorkflowStepRunner implements WorkflowStepLike {
  constructor(
    private readonly db: DatabaseSync,
    private readonly instanceId: string,
    private readonly isTerminated: () => boolean,
  ) {}

  async do<T>(name: string, config: StepConfigLike, callback: (ctx: StepContextLike) => Promise<T>): Promise<T> {
    if (this.isTerminated()) throw new Error("Workflow instance was terminated");

    // 1. 查询断点缓存（与 CF Workflows 语义一致：已持久化的 step 直接采纳输出，绝不重跑）
    const existing = this.db.prepare("SELECT output FROM _workflow_checkpoints WHERE instance_id = ? AND step_name = ?")
      .get(this.instanceId, name) as { output: string | null } | undefined;

    if (existing !== undefined) {
      return existing.output === null ? (undefined as T) : (JSON.parse(existing.output) as T);
    }

    // CF Workflows 默认重试 5 次（未显式指定 retries.limit 时）
    const limit = config?.retries?.limit ?? 5;
    const timeoutMs = config?.timeout ? parseDuration(config.timeout) : 0;

    for (let attempt = 1; ; attempt += 1) {
      if (this.isTerminated()) throw new Error("Workflow instance was terminated");
      try {
        const resultPromise = callback({ attempt, step: { name, count: attempt } });
        let result: T;
        if (timeoutMs > 0) {
          let timer: NodeJS.Timeout;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const err = new Error(`Step "${name}" timed out after ${timeoutMs}ms`);
              err.name = "TimeoutError";
              reject(err);
            }, timeoutMs);
          });
          result = await Promise.race([resultPromise, timeoutPromise]).finally(() => clearTimeout(timer));
        } else {
          result = await resultPromise;
        }

        const serialized = result === undefined ? null : JSON.stringify(result);

        this.db.prepare(`
          INSERT OR REPLACE INTO _workflow_checkpoints (instance_id, step_name, output, created_at)
          VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        `).run(this.instanceId, name, serialized);

        return result;
      } catch (error) {
        if (isNonRetryableError(error) || attempt > limit) {
          throw error;
        }

        let delayMs = 0;
        const delayCfg = config?.retries?.delay;
        if (typeof delayCfg === "function") {
          const calculated = delayCfg({ ctx: { attempt, step: { name, count: attempt } }, error: error as Error });
          delayMs = parseDuration(calculated);
        } else if (delayCfg !== undefined) {
          delayMs = parseDuration(delayCfg);
        } else {
          // CF 默认退避：指数退避，基数 1s，上限 60s
          delayMs = Math.min(60000, 1000 * Math.pow(2, attempt - 1));
        }

        if (delayMs > 0) {
          await new Promise(res => setTimeout(res, delayMs));
        }
      }
    }
  }

  async sleep(name: string, duration: string | number): Promise<void> {
    if (this.isTerminated()) throw new Error("Workflow instance was terminated");
    const sleepKey = `sleep:${name}`;
    const existing = this.db.prepare("SELECT 1 FROM _workflow_checkpoints WHERE instance_id = ? AND step_name = ?")
      .get(this.instanceId, sleepKey);
    if (existing) return;

    const ms = parseDuration(duration);
    if (ms > 0) {
      await new Promise(res => setTimeout(res, ms));
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO _workflow_checkpoints (instance_id, step_name, output, created_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(this.instanceId, sleepKey, "true");
  }
}

export function createLocalWorkflowEngine(options: LocalWorkflowEngineOptions): TaskWorkflowEngine & {
  resumeRunningWorkflows: () => Promise<number>;
  waitForInstance: (id: string, timeoutMs?: number) => Promise<string>;
} {
  const { db, handler } = options;
  const activeAborts = new Map<string, () => void>();
  const activePromises = new Map<string, Promise<unknown>>();

  const runInstance = async (id: string, params: unknown) => {
    let terminated = false;
    activeAborts.set(id, () => {
      terminated = true;
    });

    const step = new LocalWorkflowStepRunner(db, id, () => terminated);
    try {
      await handler(params, id, step);
      if (!terminated) {
        db.prepare(`
          UPDATE _workflow_instances
          SET status = 'complete', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND status = 'running'
        `).run(id);
      }
    } catch (err) {
      if (!terminated) {
        db.prepare(`
          UPDATE _workflow_instances
          SET status = 'errored', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND status = 'running'
        `).run(id);
      }
    } finally {
      activeAborts.delete(id);
      activePromises.delete(id);
    }
  };

  return {
    async create(createOpts: { id: string; params: unknown }): Promise<{ id: string }> {
      const existing = db.prepare("SELECT status FROM _workflow_instances WHERE id = ?").get(createOpts.id) as { status: string } | undefined;
      if (existing) {
        throw new Error("instance.already_exists");
      }

      db.prepare(`
        INSERT INTO _workflow_instances (id, params, status, created_at, updated_at)
        VALUES (?, ?, 'running', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(createOpts.id, JSON.stringify(createOpts.params));

      const promise = runInstance(createOpts.id, createOpts.params);
      activePromises.set(createOpts.id, promise);

      return { id: createOpts.id };
    },

    async get(id: string): Promise<TaskWorkflowInstance> {
      const row = db.prepare("SELECT status FROM _workflow_instances WHERE id = ?").get(id) as { status: string } | undefined;
      if (!row) {
        throw new Error("instance.not_found");
      }

      return {
        id,
        status: async () => {
          const current = db.prepare("SELECT status FROM _workflow_instances WHERE id = ?").get(id) as { status: string } | undefined;
          return { status: current?.status ?? "unknown" };
        },
        terminate: async () => {
          activeAborts.get(id)?.();
          db.prepare(`
            UPDATE _workflow_instances
            SET status = 'terminated', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?
          `).run(id);
        },
      };
    },

    async resumeRunningWorkflows(): Promise<number> {
      const rows = db.prepare("SELECT id, params FROM _workflow_instances WHERE status = 'running'")
        .all() as Array<{ id: string; params: string }>;

      let resumed = 0;
      for (const row of rows) {
        if (!activePromises.has(row.id)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.params);
          } catch {
            continue;
          }
          const promise = runInstance(row.id, parsed);
          activePromises.set(row.id, promise);
          resumed += 1;
        }
      }
      return resumed;
    },

    async waitForInstance(id: string, timeoutMs = 30000): Promise<string> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const row = db.prepare("SELECT status FROM _workflow_instances WHERE id = ?").get(id) as { status: string } | undefined;
        if (row && ["complete", "errored", "terminated"].includes(row.status)) {
          return row.status;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      const final = db.prepare("SELECT status FROM _workflow_instances WHERE id = ?").get(id) as { status: string } | undefined;
      return final?.status ?? "unknown";
    },
  };
}
