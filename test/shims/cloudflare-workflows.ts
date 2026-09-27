/**
 * vitest 环境下的 `cloudflare:workflows` 最小等价实现（仅测试使用）。
 * 生产代码用 NonRetryableError 终止 Workflow step 重试；测试 shim 保持同一 instanceof 语义。
 */
export class NonRetryableError extends Error {
  constructor(message: string, name?: string) {
    super(message);
    this.name = name ?? "NonRetryableError";
  }
}
