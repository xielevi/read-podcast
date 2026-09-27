/**
 * Cloudflare 平台薄适配层：把 Cloudflare Workers 绑定（D1 / R2 / Workflows / Assets）
 * 包装为平台中立的最小接口，保持现有线上与测试行为 100% 不变。
 *
 * 架构护栏：只有本文件与 src/index.ts 允许直接导入 cloudflare:* 或引用 CF 绑定类型。
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { presignR2Get, type R2SigningCredentials } from "../transcription/r2_presign";
import { r2Credentials } from "../transcription/source";
import type { ProcessingWorkflowParams } from "../workflows/common";
import { runProcessingPipeline } from "../workflows/pipeline";
import type { Env } from "../types";
import type {
  Database,
  MultipartUpload,
  ObjectListing,
  ObjectMetadata,
  ObjectStore,
  Statement,
  StoredObject,
  TaskWorkflowEngine,
  TaskWorkflowInstance,
  WorkflowStepLike,
} from "./types";

/**
 * Cloudflare Worker 注入的原始环境（仅在适配层与 worker 入口可见）。
 */
export interface CloudflareEnv {
  DB?: D1Database;
  RAW_BUCKET?: R2Bucket;
  ASSETS?: Fetcher;
  PROCESSING_WORKFLOW?: Workflow<ProcessingWorkflowParams>;
  APP_ENV?: string;
  TRANSCRIPTION_SERVICE_URL?: string;
  TRANSCRIPTION_LANGUAGE?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  REFINER_API_KEY?: string;
  GITHUB_TOKEN?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  GITHUB_PODCAST_PATH?: string;
  MANUSCRIPT_TIME_ZONE?: string;
  GITHUB_API_BASE?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  [key: string]: unknown;
}

// ── D1 适配器 ──

class D1StatementAdapter implements Statement {
  constructor(public readonly rawStmt: any) {}

  bind(...values: unknown[]): Statement {
    return new D1StatementAdapter(this.rawStmt.bind(...values));
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    return this.rawStmt.first(colName);
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const res = await this.rawStmt.all();
    return { results: res.results };
  }

  async run<T = Record<string, unknown>>(): Promise<{ meta: { changes?: number }; success?: boolean; results?: T[] }> {
    const res = await this.rawStmt.run();
    return { meta: { changes: res.meta?.changes }, success: res.success, results: res.results };
  }

  batchResult() {
    if (typeof this.rawStmt.batchResult === "function") {
      return this.rawStmt.batchResult();
    }
    return undefined;
  }
}

export function adaptD1Database(d1: D1Database): Database {
  return {
    prepare(query: string): Statement {
      return new D1StatementAdapter(d1.prepare(query));
    },
    async batch<T = unknown>(statements: Statement[]): Promise<T[]> {
      const rawStmts = statements.map(s => (s instanceof D1StatementAdapter ? s.rawStmt : s));
      const results = await d1.batch(rawStmts as any);
      return results as T[];
    },
  };
}

// ── R2 适配器 ──

function adaptMultipart(mp: R2MultipartUpload): MultipartUpload {
  return {
    uploadId: mp.uploadId,
    key: mp.key,
    uploadPart: (partNumber, value) => mp.uploadPart(partNumber, value as any),
    complete: parts => mp.complete(parts),
    abort: () => mp.abort(),
  };
}

export function adaptR2Bucket(bucket: R2Bucket, getCredentials?: () => R2SigningCredentials): ObjectStore {
  return {
    async get(key: string): Promise<StoredObject | null> {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return {
        key: obj.key,
        size: obj.size,
        text: async () => obj.text(),
        body: obj.body,
      };
    },
    async put(key: string, value: any, options?: any) {
      const res = await bucket.put(key, value, options);
      return { key: res ? res.key : key, size: res ? res.size : 0 };
    },
    async delete(key: string | string[]) {
      await bucket.delete(key as any);
    },
    async head(key: string): Promise<ObjectMetadata | null> {
      const res = await bucket.head(key);
      if (!res) return null;
      return {
        key: res.key,
        size: res.size,
        uploaded: res.uploaded,
        httpEtag: res.httpEtag,
      };
    },
    async list(options?: { prefix?: string; limit?: number }): Promise<ObjectListing> {
      const res = await bucket.list(options);
      return {
        objects: res.objects.map(o => ({
          key: o.key,
          size: o.size,
          uploaded: o.uploaded,
        })),
        truncated: res.truncated,
      };
    },
    async createMultipartUpload(key: string, options?: any) {
      const mp = await bucket.createMultipartUpload(key, options);
      return adaptMultipart(mp);
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      const mp = bucket.resumeMultipartUpload(key, uploadId);
      return adaptMultipart(mp);
    },
    async createPresignedUrl(key: string, options?: { nowMs?: number; expiresInSeconds?: number }) {
      if (!getCredentials) {
        throw new Error("Presigned URL generation requires credential resolver");
      }
      const creds = getCredentials();
      return presignR2Get(creds, key, options?.nowMs, options?.expiresInSeconds);
    },
  };
}

// ── Workflows 适配器 ──

export function adaptWorkflow(workflow: Workflow<any>): TaskWorkflowEngine {
  return {
    async create(options) {
      return workflow.create(options as any);
    },
    async get(id: string): Promise<TaskWorkflowInstance> {
      const instance = await workflow.get(id);
      return {
        id: instance.id,
        status: async () => {
          const s = await instance.status();
          return { status: String(s.status) };
        },
        terminate: async () => {
          await instance.terminate();
        },
      };
    },
  };
}

export function adaptWorkflowStep(step: WorkflowStep): WorkflowStepLike {
  return {
    do: (name, config, callback) => step.do(name, config as any, callback as any) as any,
    sleep: (name, duration) => step.sleep(name, duration as any),
  };
}

/**
 * Cloudflare Workflows 的执行入口：解耦后委托给 platform-neutral 的 runProcessingPipeline。
 */
export class ProcessingWorkflow extends WorkflowEntrypoint<CloudflareEnv, ProcessingWorkflowParams> {
  async run(event: WorkflowEvent<ProcessingWorkflowParams>, step: WorkflowStep): Promise<unknown> {
    const platformEnv = adaptCloudflareEnv(this.env);
    const platformStep = adaptWorkflowStep(step);
    return runProcessingPipeline(platformEnv, event.payload, event.instanceId, platformStep);
  }
}

// ── 全量 Env 适配函数 ──

export function adaptCloudflareEnv(raw: CloudflareEnv | Env): Env {
  const result: any = { ...raw };
  const db = result.db ?? (result.DB ? adaptD1Database(result.DB) : undefined);
  const storage = result.storage ?? (result.RAW_BUCKET ? adaptR2Bucket(result.RAW_BUCKET, () => r2Credentials(result)) : undefined);
  const workflows = result.workflows ?? (result.PROCESSING_WORKFLOW ? adaptWorkflow(result.PROCESSING_WORKFLOW) : undefined);
  const assets = result.assets ?? (result.ASSETS ? { fetch: (req: Request) => result.ASSETS.fetch(req) } : undefined);

  result.db = db;
  result.storage = storage;
  result.workflows = workflows;
  result.assets = assets;

  return result as Env;
}
