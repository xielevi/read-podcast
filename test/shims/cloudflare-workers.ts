/**
 * vitest 环境下的 `cloudflare:workers` 最小等价实现（仅测试使用）。
 * 生产运行时由 workerd 提供真实模块；此处只保证模块可解析、类可实例化。
 */
export class WorkflowEntrypoint<Env = unknown, T = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async run(_event: unknown, _step: unknown): Promise<unknown> {
    throw new Error("WorkflowEntrypoint.run is not implemented (test shim)");
  }
}
