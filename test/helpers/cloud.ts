/**
 * 编排层测试的共享装置：真实 SQLite（D1 等价）+ 内存 R2 / Workflow 绑定 + 一个「遵守协议的假转录服务」+
 * 假 GitHub / 假 LLM + 模拟 Workflows durable step 语义的引擎。
 *
 * 假转录服务是一个**纯 HTTP 协议实现**（只通过 fetch 触达）：这正是「换一台转录机器」的验收形态——
 * Cloudflare 侧代码对它一无所知，只认 /v1/transcriptions 契约。
 */
import { DEFAULT_REFINER_SETTINGS } from "../../src/refinement/defaults";
import type { StepConfigLike, StepContextLike, WorkflowStepLike } from "../../src/workflows/common";
import type { PollTuning } from "../../src/workflows/transcription";
import type { Env } from "../../src/types";
import { createD1, type SqliteD1 } from "./sqlite-d1";

export const TASK = "12345678-1234-1234-1234-123456789abc";
export const ATTEMPT = "aaaaaaaa-0000-0000-0000-000000000001";
export const SERVICE_URL = "https://transcribe.test";
/** Cloudflare Access service token（转录服务入口的保护；Mac 上不存在对应凭据）。 */
export const ACCESS_CLIENT_ID = "access-client-id";
export const ACCESS_CLIENT_SECRET = "access-client-secret";
/** 签发 presigned GET 的最小权限 R2 凭据（转录服务永远看不到这几个值）。 */
export const R2_ACCOUNT_ID = "acct-test";
export const R2_ACCESS_KEY_ID = "AKIATESTACCESSKEYID";
export const R2_SECRET_ACCESS_KEY = "test-secret-access-key-material";
export const R2_BUCKET = "read-podcast-edge-raw";
export const UPLOAD_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
export const UPLOAD_KEY = `uploads/${UPLOAD_ID}/a.mp3`;

export const RAW_TEXT = "这是一段原始转录内容，用于验证精修质量门禁。".repeat(80);
export const REFINED_TEXT = `### 📌 节目大纲与时间线\n- **00:00** 开场\n\n## 01 | 主题\n\n**程衍樑**：${RAW_TEXT}`;

/** 测试里的 poll 调参：不真实等待。 */
export const FAST_POLL: PollTuning & { maxTranscriptionMs?: number } = { windowMs: 1_000, maxPolls: 3, waitSeconds: 0, minIntervalMs: 0 };

// ── 内存 R2 ──

interface StoredObject {
  bytes: Uint8Array;
  uploaded: Date;
  contentType?: string;
}

export class FakeR2 {
  readonly objects = new Map<string, StoredObject>();
  readonly putLog: string[] = [];
  readonly deleteLog: string[] = [];
  readonly getLog: string[] = [];

  async put(key: string, value: string | ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    let bytes: Uint8Array;
    if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof ReadableStream) {
      // 只计数、不缓冲：上传测试会流过接近 200 MiB 的合成数据。流中途出错则 put 拒绝且不落对象（与 R2 一致）。
      const size = await countStream(value);
      this.objects.set(key, { bytes: { byteLength: size } as unknown as Uint8Array, uploaded: new Date(), contentType: options?.httpMetadata?.contentType });
      this.putLog.push(key);
      return { key, size };
    } else bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.objects.set(key, { bytes, uploaded: new Date(), contentType: options?.httpMetadata?.contentType });
    this.putLog.push(key);
    return { key, size: bytes.byteLength };
  }

  /** 直接放一个指定大小的对象（不占真实内存：只记录大小）。 */
  putSized(key: string, size: number): void {
    const bytes = { byteLength: size } as unknown as Uint8Array;
    this.objects.set(key, { bytes, uploaded: new Date() });
  }

  async get(key: string) {
    this.getLog.push(key);
    const object = this.objects.get(key);
    if (!object) return null;
    const size = object.bytes.byteLength;
    return {
      key,
      size,
      httpEtag: `"etag-${key}"`,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          if (object.bytes instanceof Uint8Array) controller.enqueue(object.bytes);
          controller.close();
        },
      }),
      text: async () => new TextDecoder().decode(object.bytes),
      writeHttpMetadata: (headers: Headers) => {
        if (object.contentType) headers.set("content-type", object.contentType);
      },
    };
  }

  /** 只读元数据（不读 body）——presigned source 解析用它判断「存在 + 不超 200 MiB」。 */
  async head(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { key, size: object.bytes.byteLength, uploaded: object.uploaded, httpEtag: `"etag-${key}"` };
  }

  async delete(key: string | string[]) {
    for (const item of Array.isArray(key) ? key : [key]) {
      this.objects.delete(item);
      this.deleteLog.push(item);
    }
  }

  async list(options: { prefix?: string; limit?: number } = {}) {
    const prefix = options.prefix ?? "";
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, options.limit ?? 1000)
      .map(([key, object]) => ({ key, size: object.bytes.byteLength, uploaded: object.uploaded }));
    return { objects, truncated: false };
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter(key => key.startsWith(prefix));
  }

  // ── multipart ──
  readonly multiparts = new Map<string, { key: string; parts: Map<number, number>; aborted: boolean }>();
  /** 强制 complete 时组装出的对象大小（模拟绕过分片累计限制的真实超限对象）。 */
  assembledSizeOverride: number | null = null;
  private multipartCounter = 0;

  async createMultipartUpload(key: string) {
    const uploadId = `r2mp-${(this.multipartCounter += 1)}`;
    this.multiparts.set(uploadId, { key, parts: new Map(), aborted: false });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const state = this.multiparts.get(uploadId);
    if (!state || state.key !== key) throw new Error("multipart upload not found");
    return {
      uploadId,
      key,
      uploadPart: async (partNumber: number, value: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer) => {
        const size = value instanceof ReadableStream ? await countStream(value) : value.byteLength;
        state.parts.set(partNumber, size);
        return { partNumber, etag: `etag-${uploadId}-${partNumber}` };
      },
      complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
        let size = 0;
        for (const part of parts) {
          const stored = state.parts.get(part.partNumber);
          if (stored === undefined) throw new Error(`part ${part.partNumber} was never uploaded`);
          size += stored;
        }
        const finalSize = this.assembledSizeOverride ?? size;
        this.putSized(key, finalSize);
        return { key, size: finalSize };
      },
      abort: async () => {
        state.aborted = true;
      },
    };
  }
}

/** 逐块读完一个流并返回字节数（不缓冲内容）。 */
export async function countStream(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength ?? 0;
  }
  return total;
}

/** 合成 `size` 字节的上传流（1 MiB 一块，惰性生成）；可选 `lieContentLength` 由调用方自行设置头。 */
export function syntheticStream(size: number, chunk = 1024 * 1024): ReadableStream<Uint8Array> {
  let remaining = size;
  const block = new Uint8Array(Math.min(chunk, Math.max(size, 1)));
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const take = Math.min(remaining, block.byteLength);
      controller.enqueue(take === block.byteLength ? block : block.subarray(0, take));
      remaining -= take;
    },
  });
}

// ── Workflow 绑定 ──

export class FakeWorkflowBinding {
  readonly instances = new Map<string, { params: unknown; status: string; terminated: boolean }>();
  readonly created: Array<{ id: string; params: unknown }> = [];
  createError: Error | null = null;

  async create(options: { id: string; params: unknown }) {
    if (this.createError) throw this.createError;
    if (this.instances.has(options.id)) throw new Error("instance.already_exists");
    this.instances.set(options.id, { params: options.params, status: "running", terminated: false });
    this.created.push({ id: options.id, params: options.params });
    return { id: options.id };
  }

  async get(id: string) {
    const instance = this.instances.get(id);
    if (!instance) throw new Error("instance.not_found");
    return {
      id,
      status: async () => ({ status: instance.status }),
      terminate: async () => {
        instance.terminated = true;
        instance.status = "terminated";
      },
    };
  }
}

// ── 遵守协议的假转录服务（只通过 fetch 触达） ──

export interface FakeJob {
  requestId: string;
  providerRequestId: string;
  source: { type: string; url: string; max_bytes?: number };
  options?: Record<string, unknown>;
  step: number;
  cancelled: boolean;
  failure?: { code: string; message: string };
}

type Step = { phase: "fetching" | "preparing" | "transcribing"; percent: number; message?: string } | "done";

const DEFAULT_STEPS: Step[] = [
  { phase: "fetching", percent: 50 },
  { phase: "preparing", percent: 0 },
  { phase: "transcribing", percent: 40, message: "Whisper 分片 2/5" },
  { phase: "transcribing", percent: 80 },
  "done",
];

export class FakeTranscriptionService {
  readonly jobs = new Map<string, FakeJob>();
  readonly byRequestId = new Map<string, FakeJob>();
  readonly log: Array<{ method: string; path: string; body?: any }> = [];
  steps: Step[] = DEFAULT_STEPS;
  resultText = RAW_TEXT;
  /** true → 连不上（fetch 抛 TypeError） */
  offline = false;
  /** 提交时的一次性错误状态码队列（例如 [503, 503]） */
  submitStatuses: number[] = [];
  pollStatuses: number[] = [];
  /** 让所有作业永远停在 running（模拟 provider 卡死） */
  hang = false;
  /** 作业在第一次轮询时失败 */
  failWith: { code: string; message?: string } | null = null;
  /** 抛出的传输错误（默认 TypeError → unreachable）；可换成 TimeoutError */
  transportError: Error | null = null;
  accessClientId = ACCESS_CLIENT_ID;
  accessClientSecret = ACCESS_CLIENT_SECRET;
  counter = 0;
  /** 对 GET 返回的快照做篡改（模拟串线 / 陈旧响应）。 */
  mutateSnapshot: ((snapshot: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /**
   * 模拟「服务已经接收并创建了请求，但 Cloudflare 侧在拿到响应前失败」
   * （TLS / 代理断连 / response timeout）。每次 POST 消耗一个，**请求本身照常创建**——
   * 这正是 durable retry 之后必须复用同一个 source URL 的场景。
   */
  dropSubmitResponses = 0;
  /** `/result` 被取回的次数（用来断言 raw 只被传输一次）。 */
  resultFetches = 0;

  get posts() {
    return this.log.filter(entry => entry.method === "POST");
  }
  get deletes() {
    return this.log.filter(entry => entry.method === "DELETE");
  }

  /** 模拟服务进程重启：所有运行态请求消失（Cloudflare 应重新提交）。 */
  restart(): void {
    this.jobs.clear();
    this.byRequestId.clear();
  }

  private snapshot(job: FakeJob, advance: boolean): Record<string, unknown> {
    if (job.cancelled) return { request_id: job.requestId, provider_request_id: job.providerRequestId, status: "cancelled" };
    const base = { request_id: job.requestId, provider_request_id: job.providerRequestId };
    if (job.failure) return { ...base, status: "failed", error: job.failure };
    if (this.failWith && advance) {
      job.failure = { code: this.failWith.code, message: this.failWith.message ?? this.failWith.code };
      return { ...base, status: "failed", error: job.failure };
    }
    if (this.hang) return { ...base, status: "running", progress: { phase: "transcribing", percent: 5 } };
    if (advance && job.step < this.steps.length - 1) job.step += 1;
    const step = this.steps[Math.min(job.step, this.steps.length - 1)];
    if (step === "done") {
      // 与真实服务一致：状态快照只回**元数据**，正文走 /result。
      return {
        ...base,
        status: "completed",
        progress: { phase: "transcribing", percent: 100 },
        result: { language: "zh", duration: 7200 },
      };
    }
    return { ...base, status: "running", progress: step };
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (this.offline) throw this.transportError ?? new TypeError("fetch failed");
    if (this.transportError) throw this.transportError;

    const headers = new Headers(init?.headers);
    // Cloudflare Access 在 Tunnel 入口先于服务生效：缺凭据 / 凭据错误 → 403（服务根本收不到请求）。
    if (headers.get("cf-access-client-id") !== this.accessClientId || headers.get("cf-access-client-secret") !== this.accessClientSecret) {
      return Response.json({ error: { code: "access_denied", message: "cloudflare access denied" } }, { status: 403 });
    }

    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.log.push({ method, path: url.pathname + url.search, body });

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "transcription-service", protocol: 1, engine: "fake", active_requests: this.jobs.size });
    }

    if (method === "POST" && url.pathname === "/v1/transcriptions") {
      const forced = this.submitStatuses.shift();
      if (forced) return Response.json({ error: { code: "boom", message: "boom" } }, { status: forced });
      if (body.source?.type !== "url") return Response.json({ error: { code: "unsupported_source" } }, { status: 400 });
      const existing = this.byRequestId.get(body.request_id);
      if (existing && !existing.cancelled && !existing.failure) {
        // 真实服务的幂等语义：同一 request_id 必须带同一个 source_url，否则 409 request_conflict。
        if (existing.source.url !== body.source.url) {
          return Response.json({ error: { code: "request_conflict", message: "request_id already used with a different source" } }, { status: 409 });
        }
        const replay = Response.json(this.snapshot(existing, false), { status: 200 });
        if (this.dropSubmitResponses > 0) {
          this.dropSubmitResponses -= 1;
          throw new TypeError("fetch failed"); // 请求已创建，但响应没能回到 Cloudflare
        }
        return replay;
      }
      this.counter += 1;
      const job: FakeJob = {
        requestId: body.request_id,
        providerRequestId: `tsr_${this.counter.toString().padStart(4, "0")}`,
        source: body.source,
        options: body.options,
        step: 0,
        cancelled: false,
      };
      this.jobs.set(job.providerRequestId, job);
      this.byRequestId.set(job.requestId, job);
      const accepted = Response.json({ request_id: job.requestId, provider_request_id: job.providerRequestId, status: "queued", progress: { phase: "queued", percent: 0 } }, { status: 202 });
      if (this.dropSubmitResponses > 0) {
        this.dropSubmitResponses -= 1;
        throw new TypeError("fetch failed");
      }
      return accepted;
    }

    const resultMatch = /^\/v1\/transcriptions\/([^/]+)\/result$/.exec(url.pathname);
    if (resultMatch && method === "GET") {
      this.resultFetches += 1;
      const job = this.jobs.get(decodeURIComponent(resultMatch[1]));
      if (!job) return Response.json({ error: { code: "unknown_request" } }, { status: 404 });
      if (job.cancelled || job.failure || this.failWith || this.hang || job.step < this.steps.length - 1) {
        return Response.json({ error: { code: "result_not_ready", message: "no result yet" } }, { status: 409 });
      }
      return new Response(this.resultText, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    const match = /^\/v1\/transcriptions\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const job = this.jobs.get(decodeURIComponent(match[1]));
      if (method === "GET") {
        const forced = this.pollStatuses.shift();
        if (forced) return Response.json({ error: { code: "boom" } }, { status: forced });
        if (!job) return Response.json({ error: { code: "unknown_request" } }, { status: 404 });
        const snapshot = this.snapshot(job, true);
        return Response.json(this.mutateSnapshot ? this.mutateSnapshot(snapshot) : snapshot);
      }
      if (method === "DELETE") {
        if (!job) return Response.json({ error: { code: "unknown_request" } }, { status: 404 });
        job.cancelled = true;
        return Response.json({ provider_request_id: job.providerRequestId, status: "cancelled" });
      }
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  };
}

// ── 假 GitHub + 假 LLM ──

export class FakeExternals {
  llmCalls = 0;
  llmFailures: number[] = [];
  githubFailures: number[] = [];
  github = { commits: 0, contents: 0 };
  /** 已提交到「仓库」的文件：path → 内容（使 commitPodcast 的幂等检查真实生效）。即分支 HEAD。 */
  readonly files = new Map<string, string>();
  /** 历史 commit 上的文件：`<sha>:<path>` → 内容；按 ?ref=<sha> 读取时优先命中，否则回落到 HEAD。 */
  readonly revisions = new Map<string, string>();
  private readonly blobs = new Map<string, string>();
  private pendingTree: Array<{ path: string; sha: string }> = [];
  private blobCounter = 0;
  refinedText = REFINED_TEXT;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("api.github.com")) {
      const failure = this.githubFailures.shift();
      if (failure) return new Response("github down", { status: failure });
      if (url.includes("/contents/")) {
        this.github.contents += 1;
        const parsed = new URL(url);
        const path = decodeURIComponent(parsed.pathname.split("/contents/")[1]);
        const content = this.revisions.get(`${parsed.searchParams.get("ref")}:${path}`) ?? this.files.get(path);
        return content === undefined ? new Response(null, { status: 404 }) : new Response(content, { status: 200 });
      }
      if (url.includes("/git/ref/heads/")) return Response.json({ object: { sha: "base-sha" } });
      if (url.includes("/git/commits/")) return Response.json({ tree: { sha: "tree-sha" } });
      if (url.includes("/git/blobs")) {
        const body = JSON.parse(String(init?.body));
        const sha = `blob-${(this.blobCounter += 1)}`;
        this.blobs.set(sha, new TextDecoder().decode(Uint8Array.from(atob(body.content), char => char.charCodeAt(0))));
        return Response.json({ sha }, { status: 201 });
      }
      if (url.includes("/git/trees")) {
        this.pendingTree = JSON.parse(String(init?.body)).tree;
        return Response.json({ sha: "new-tree-sha" }, { status: 201 });
      }
      if (url.includes("/git/commits") && method === "POST") return Response.json({ sha: `commit-${this.github.commits + 1}` }, { status: 201 });
      if (url.includes("/git/refs/heads/")) {
        this.github.commits += 1;
        for (const entry of this.pendingTree) this.files.set(entry.path, this.blobs.get(entry.sha) ?? "");
        return Response.json({ sha: `commit-${this.github.commits}` });
      }
      return Response.json({ sha: "commit-sha" });
    }
    if (url.includes("/chat/completions")) {
      this.llmCalls += 1;
      const failure = this.llmFailures.shift();
      if (failure) return new Response("llm failure", { status: failure });
      return Response.json({ choices: [{ message: { content: this.refinedText }, finish_reason: "stop" }] });
    }
    throw new Error(`unexpected outbound fetch: ${url}`);
  };
}

// ── durable step engine（模拟 Workflows 的 checkpoint / 重放语义） ──

/** 模拟 isolate 整体崩溃：不重试、不走失败记录（进程已经死了），只能由「重放」接管。 */
export class IsolateCrash extends Error {
  constructor(message = "isolate crashed") {
    super(message);
    this.name = "IsolateCrash";
  }
}

/**
 * 真实引擎的非重试判定（workers-sdk / workerd）：按 name 或消息前缀识别，而不是 instanceof。
 * （把 code 塞进 NonRetryableError 的 name 参数曾导致引擎把它当普通错误一路重试。）
 */
export function isEngineNonRetryable(error: unknown): boolean {
  return error instanceof Error && (error.name === "NonRetryableError" || error.message.startsWith("NonRetryableError"));
}

/**
 * 错误穿过 step 边界之后用户代码看到的样子：自定义属性（.code 等）全部丢失，只剩 name / message。
 * `preserve` 对应兼容性开关 workflows_preserve_non_retryable_error_message：关闭时消息被引擎改写。
 */
function crossStepBoundary(error: Error, nonRetryable: boolean, preserve: boolean): Error {
  const message = nonRetryable && !preserve ? `Step threw a NonRetryableError with message "${error.message}"` : error.message;
  const crossed = new Error(message);
  crossed.name = nonRetryable ? (preserve ? "NonRetryableError" : "WorkflowFatalError") : error.name;
  return crossed;
}

export class DurableStepEngine implements WorkflowStepLike {
  /** 是否模拟 workflows_preserve_non_retryable_error_message（默认两种都要测：见 processing.test.ts）。 */
  preserveNonRetryableMessage = true;
  /** 这些 step 的回调成功执行后、checkpoint 落盘前，isolate 崩溃（一次）。 */
  crashAfter = new Set<string>();
  private dead = false;

  /** 每次 step.do 调用（含命中缓存的重放） */
  readonly calls: string[] = [];
  /** 真正执行了回调的 step（命中缓存不算） */
  readonly executed: string[] = [];
  readonly attempts: Record<string, number> = {};
  readonly sleeps: string[] = [];
  private readonly cache = new Map<string, unknown>();
  /** 每个 step 的一次性注入错误（先于回调执行） */
  injected = new Map<string, Error[]>();
  /** 每个 step 的回调执行前钩子（用于在特定时点制造竞态） */
  before = new Map<string, () => Promise<void> | void>();
  /** 每个 step 的回调成功后、持久化前的钩子 */
  after = new Map<string, () => Promise<void> | void>();

  async do<T>(name: string, config: StepConfigLike, callback: (ctx: StepContextLike) => Promise<T>): Promise<T> {
    if (this.dead) throw new IsolateCrash("isolate is dead");
    this.calls.push(name);
    if (this.cache.has(name)) {
      return this.cache.get(name) as T;
    }
    const limit = config?.retries?.limit ?? 0;
    for (let attempt = 1; ; attempt += 1) {
      this.attempts[name] = attempt;
      try {
        await this.before.get(name)?.();
        const scripted = this.injected.get(name)?.shift();
        if (scripted) throw scripted;
        this.executed.push(name);
        const output = await callback({ attempt, step: { name, count: attempt } });
        await this.after.get(name)?.();
        if (this.crashAfter.has(name)) {
          this.crashAfter.delete(name);
          this.dead = true;
          throw new IsolateCrash();
        }
        this.cache.set(name, output === undefined ? output : JSON.parse(JSON.stringify(output)));
        return this.cache.get(name) as T;
      } catch (error) {
        if (error instanceof IsolateCrash) throw error;
        if (isEngineNonRetryable(error)) throw crossStepBoundary(error as Error, true, this.preserveNonRetryableMessage);
        if (attempt > limit) throw crossStepBoundary(error as Error, false, true);
      }
    }
  }

  async sleep(name: string): Promise<void> {
    this.sleeps.push(name);
  }

  /** 「重放」：同一份 checkpoint 上再跑一次（新的 engine 视图，缓存共享）。 */
  replay(): DurableStepEngine {
    const next = new DurableStepEngine();
    for (const [key, value] of this.cache) next.cache.set(key, value);
    return next;
  }
}

// ── 整体装置 ──

export interface Cloud {
  env: Env;
  d1: SqliteD1;
  r2: FakeR2;
  workflow: FakeWorkflowBinding;
  service: FakeTranscriptionService;
  externals: FakeExternals;
  /** 路由：转录服务 / GitHub / LLM */
  fetch: typeof fetch;
}

export function makeCloud(): Cloud {
  const d1 = createD1();
  const r2 = new FakeR2();
  const workflow = new FakeWorkflowBinding();
  const service = new FakeTranscriptionService();
  const externals = new FakeExternals();
  const router = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(SERVICE_URL)) return service.fetch(input, init);
    return externals.fetch(input, init);
  }) as typeof fetch;

  const env = {
    DB: d1,
    RAW_BUCKET: r2,
    PROCESSING_WORKFLOW: workflow,
    ASSETS: { fetch: async () => new Response("asset") },
    APP_ENV: "test",
    TRANSCRIPTION_SERVICE_URL: SERVICE_URL,
    CF_ACCESS_CLIENT_ID: ACCESS_CLIENT_ID,
    CF_ACCESS_CLIENT_SECRET: ACCESS_CLIENT_SECRET,
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: R2_BUCKET,
    REFINER_API_KEY: "test-key",
    GITHUB_TOKEN: "gh-token",
    GITHUB_OWNER: "test-owner",
    GITHUB_REPO: "test-repo",
    GITHUB_BRANCH: "main",
    GITHUB_PODCAST_PATH: "podcasts/transcripts",
  } as unknown as Env;

  return { env, d1, r2, workflow, service, externals, fetch: router };
}

/** 断言的便利：解析一张 presigned GET URL 的签名参数（不验证签名，只验证结构与范围）。 */
export function presignedParts(url: string): {
  origin: string;
  key: string;
  params: URLSearchParams;
} {
  const parsed = new URL(url);
  return { origin: parsed.origin, key: decodeURIComponent(parsed.pathname), params: parsed.searchParams };
}

export function seedEpisode(d1: SqliteD1, id = "ep-1", audioUrl = "https://cdn.example.com/a.mp3"): void {
  d1.raw.prepare("INSERT OR IGNORE INTO subscriptions (id, name, rss_url) VALUES (1, '忽左忽右', 'https://example.com/rss')").run();
  d1.raw.prepare(`INSERT OR IGNORE INTO episodes
    (id, subscription_id, podcast_name, title, audio_url, summary, link, published, published_date, duration)
    VALUES (?, 1, '忽左忽右', '474 孙立天谈康熙废储（精修）', ?, '本期嘉宾孙立天，时间线：01:20 开场。', 'https://example.com/ep',
            'Tue, 19 May 2026 08:00:00 +0000', '20260519', '01:02:03')`).run(id, audioUrl);
}

export interface TaskSeed {
  id?: string;
  status?: string;
  attempt?: string;
  source_type?: "rss" | "upload";
  episode_id?: string | null;
  audio_url?: string;
  raw_object_key?: string | null;
  provider_request_id?: string | null;
  error_code?: string | null;
  progress?: number;
  cancel_requested?: number;
  message?: string;
  updated_at?: string;
}

export function insertTask(d1: SqliteD1, seed: TaskSeed = {}): string {
  const id = seed.id ?? TASK;
  const sourceType = seed.source_type ?? "rss";
  if (sourceType === "rss" && seed.episode_id !== null) seedEpisode(d1);
  d1.raw.prepare(`INSERT INTO tasks
    (id, episode_id, source_type, podcast_name, episode_title, audio_url, status, progress, message,
     current_attempt_id, cancel_requested, raw_object_key, provider_request_id, error_code, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`)
    .run(
      id,
      sourceType === "rss" ? (seed.episode_id === undefined ? "ep-1" : seed.episode_id) : null,
      sourceType,
      sourceType === "rss" ? "忽左忽右" : "本地音频",
      "474 孙立天谈康熙废储（精修）",
      seed.audio_url ?? "https://cdn.example.com/a.mp3",
      seed.status ?? "queued",
      seed.progress ?? 0,
      seed.message ?? "已排队",
      seed.attempt ?? ATTEMPT,
      seed.cancel_requested ?? 0,
      seed.raw_object_key ?? null,
      seed.provider_request_id ?? null,
      seed.error_code ?? null,
      seed.updated_at ?? null,
    );
  return id;
}

export function taskRow(d1: SqliteD1, id = TASK): Record<string, any> {
  return { ...(d1.raw.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, any>) };
}

export function paramsFor(taskId = TASK, attemptId = ATTEMPT) {
  return { taskId, attemptId, config: { ...DEFAULT_REFINER_SETTINGS } };
}

export const ctxStub = (() => {
  const pending: Array<Promise<unknown>> = [];
  return {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => {},
    settle: async () => {
      await Promise.allSettled(pending.splice(0));
    },
  } as unknown as ExecutionContext & { settle: () => Promise<void> };
})();
