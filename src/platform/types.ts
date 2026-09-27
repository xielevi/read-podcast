/**
 * 平台最小接口定义：解耦业务层与具体云平台/宿主运行时（Cloudflare / Docker）。
 *
 * 遵循架构约定：当且仅当存在第二个具体实现（Docker 本地部署 #27/#28）时引入抽象。
 * 业务代码仅依赖本文件定义的接口，不直接依赖 Cloudflare 专有绑定。
 */

// ── 数据库接口（按 D1 / SQLite 预编译语句形态设计）──

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<{ meta: { changes?: number }; success?: boolean; results?: T[] }>;
}

export interface StatementResult<T = Record<string, unknown>> {
  results: T[];
  meta?: {
    changes?: number;
    [key: string]: unknown;
  };
  success?: boolean;
}

export interface Database {
  prepare(query: string): Statement;
  batch<T = StatementResult>(statements: Statement[]): Promise<T[]>;
}

// ── 对象存储接口（临时 raw / uploads / checkpoints）──

export interface StoredObject {
  key: string;
  size: number;
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}

export interface ObjectMetadata {
  key: string;
  size: number;
  uploaded?: Date;
  httpEtag?: string;
}

export interface ObjectListing {
  objects: Array<{
    key: string;
    size: number;
    uploaded?: Date;
  }>;
  truncated?: boolean;
}

export interface MultipartUpload {
  uploadId: string;
  key: string;
  uploadPart(partNumber: number, value: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer): Promise<{ partNumber: number; etag: string }>;
  complete(parts: Array<{ partNumber: number; etag: string }>): Promise<{ key: string; size: number }>;
  abort(): Promise<void>;
}

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  put(
    key: string,
    value: string | ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<{ key: string; size: number }>;
  delete(key: string | string[]): Promise<void>;
  head(key: string): Promise<ObjectMetadata | null>;
  list(options?: { prefix?: string; limit?: number }): Promise<ObjectListing>;
  createMultipartUpload?(
    key: string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<MultipartUpload>;
  resumeMultipartUpload?(key: string, uploadId: string): MultipartUpload;
  createPresignedUrl?(key: string, options?: { nowMs?: number; expiresInSeconds?: number }): Promise<string>;
}

// ── 任务工作流接口（durable step 执行与实例管理）──

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

export interface TaskWorkflowInstance {
  id: string;
  status(): Promise<{ status: string }>;
  terminate(): Promise<void>;
}

export interface TaskWorkflowEngine {
  create(options: { id: string; params: unknown; retention?: { successRetention?: string | number; errorRetention?: string | number } }): Promise<{ id: string }>;
  get(id: string): Promise<TaskWorkflowInstance>;
}

/**
 * 平台中立的非重试异常：通知工作流引擎该步骤失败不可恢复，立即终止重试。
 */
export class NonRetryableError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "NonRetryableError";
    if (code) this.code = code;
  }
}

// ── 定时维护入口 ──

export interface ScheduledEvent {
  cron?: string;
  scheduledTime?: number;
}

export type ScheduledHandler = (event?: ScheduledEvent) => Promise<void>;
