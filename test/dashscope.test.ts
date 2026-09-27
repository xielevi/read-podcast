/**
 * 云端转录适配器（百炼 Paraformer）：协议翻译、错误码映射、provider 分发、RSS 跳转跟随、
 * 以及 Workflow 集成（成功 / 失败 / 重放幂等）。
 *
 * 假百炼服务是纯 HTTP 协议实现（只通过 fetch 触达）：Cloudflare 侧对它的全部认知就是
 * dashscope.ts 里的那几个端点——正是「接一家云端服务商」的验收形态。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NON_RETRYABLE_PROVIDER_ERRORS,
  TranscriptionServiceError,
  taskErrorCodeForProvider,
} from "../src/transcription/contract";
import { DASHSCOPE_BASE_URL, fetchDashscopeTranscriptionResult, pollDashscopeTranscription, providerCodeForDashscopeFailure, submitDashscopeTranscription } from "../src/transcription/dashscope";
import { checkServiceHealth, submitTranscription, transcriptionProvider } from "../src/transcription/client";
import { resolveFinalAudioUrl, resolveTranscriptionSource } from "../src/transcription/source";
import { runProcessingPipeline } from "../src/workflows/pipeline";
import { processingWorkflowId } from "../src/workflows/processing";
import { submitStepName } from "../src/workflows/transcription";
import { DurableStepEngine, IsolateCrash, FAST_POLL, RAW_TEXT, TASK, ATTEMPT, insertTask, makeCloud, paramsFor, taskRow, type Cloud, type TaskSeed } from "./helpers/cloud";
import { rawObjectKey } from "../src/raw";

const INSTANCE = processingWorkflowId(TASK, ATTEMPT);
const RAW_KEY = rawObjectKey(TASK, ATTEMPT);
const API_KEY = "sk-dashscope-test-key";
const RESULT_URL = "https://dashscope-result.test/0cbf/result.json?Expires=9999999999";
const AUDIO_URL = "https://cdn.example.com/a.mp3";

const dashEnv = (extra: Record<string, string | undefined> = {}) =>
  ({ TRANSCRIPTION_PROVIDER: "dashscope", DASHSCOPE_API_KEY: API_KEY, ...extra }) as never;

// ── 假百炼服务 ──

const SENTENCES = Array.from({ length: 300 }, (_, i) => ({ begin_time: i * 5000, end_time: (i + 1) * 5000, text: `这是云端转录的第${i + 1}句内容，用于验证端到端流程。` }));
const SENTENCE_TEXT = SENTENCES.map(sentence => sentence.text).join("");
const DEFAULT_RESULT_JSON = {
  file_url: AUDIO_URL,
  properties: { audio_format: "mp3", channels: [0], original_sampling_rate: 44100, original_duration_in_milliseconds: 1_500_000 },
  transcripts: [{ channel_id: 0, content_duration_in_milliseconds: 1_498_000, text: RAW_TEXT, sentences: SENTENCES }],
};

type DashPhase = "PENDING" | "RUNNING";

export class FakeDashScope {
  readonly log: Array<{ method: string; path: string; body?: any; authorization?: string; asyncHeader?: string | null }> = [];
  /** 查询时的状态脚本：依次消耗，耗尽后 → SUCCEEDED */
  phases: DashPhase[] = ["PENDING", "RUNNING"];
  /** 让任务以 FAILED 终止（code / message 原样进 output） */
  failWith: { code?: string; message?: string } | null = null;
  submitStatuses: number[] = [];
  offline = false;
  /** 提交已被服务端接收、但响应没有回到 Cloudflare（每次 POST 消耗一个） */
  dropSubmitResponses = 0;
  resultJson: unknown = DEFAULT_RESULT_JSON;
  resultStatus = 200;
  apiKey = API_KEY;
  counter = 0;
  resultFetches = 0;
  private readonly cursors = new Map<string, number>();
  private readonly taskIds = new Set<string>();

  /** 单元测试默认预置 dash-task-1（未经提交直接查询的场景）；Workflow 集成用 preseed=false。 */
  constructor(preseed = true) {
    if (preseed) this.taskIds.add("dash-task-1");
  }

  get posts() {
    return this.log.filter(entry => entry.method === "POST");
  }
  get queries() {
    return this.log.filter(entry => entry.method === "GET" && entry.path.startsWith("/api/v1/tasks/"));
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.offline) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const authorization = new Headers(init?.headers).get("authorization") ?? "";

    // 结果 URL 由 OSS 预签名，不需要（也不带）Authorization
    if (url.origin === "https://dashscope-result.test" && method === "GET") {
      this.resultFetches += 1;
      if (this.resultStatus !== 200) return new Response("expired", { status: this.resultStatus });
      return Response.json(this.resultJson);
    }

    // 其余都是 DashScope API 端点：必须带 Bearer
    if (authorization !== `Bearer ${this.apiKey}`) {
      return Response.json({ code: "InvalidApiKey", message: "Invalid API-key provided." }, { status: 401 });
    }

    if (method === "POST" && url.pathname === "/api/v1/services/audio/asr/transcription") {
      this.log.push({
        method,
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization,
        asyncHeader: new Headers(init?.headers).get("X-DashScope-Async"),
      });
      const forced = this.submitStatuses.shift();
      if (forced) return Response.json({ code: "Throttling", message: "Requests throttling triggered." }, { status: forced });
      if (this.dropSubmitResponses > 0) {
        this.dropSubmitResponses -= 1;
        this.counter += 1; // 请求已创建，但响应丢失
        throw new TypeError("fetch failed");
      }
      this.counter += 1;
      this.taskIds.add(`dash-task-${this.counter}`);
      return Response.json(
        { request_id: `req-${this.counter}`, output: { task_id: `dash-task-${this.counter}`, task_status: "PENDING" }, usage: null },
        { status: 200 },
      );
    }

    const taskMatch = /^\/api\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
    if (taskMatch && method === "GET") {
      const taskId = decodeURIComponent(taskMatch[1]);
      const created = this.taskIds.has(taskId);
      this.log.push({ method, path: url.pathname, authorization });
      if (!created) return Response.json({ code: "NotFoundTaskId", message: "Task not found" }, { status: 404 });
      if (this.failWith) {
        return Response.json({ request_id: "req-x", output: { task_id: taskId, task_status: "FAILED", code: this.failWith.code ?? "", message: this.failWith.message ?? "" } });
      }
      const cursor = this.cursors.get(taskId) ?? 0;
      if (cursor < this.phases.length) {
        this.cursors.set(taskId, cursor + 1);
        return Response.json({ request_id: "req-x", output: { task_id: taskId, task_status: this.phases[cursor] } });
      }
      return Response.json({
        request_id: "req-x",
        output: {
          task_id: taskId,
          task_status: "SUCCEEDED",
          results: [{ file_url: AUDIO_URL, transcription_url: RESULT_URL, subtask_status: "SUCCEEDED" }],
        },
        usage: { duration: 1500 },
      });
    }

    return Response.json({ code: "NotFound", message: url.pathname }, { status: 404 });
  };
}

// ── Workflow 集成装置 ──

function route(cloud: Cloud, ds: FakeDashScope): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(DASHSCOPE_BASE_URL) || url.startsWith("https://dashscope-result.test")) return ds.fetch(input, init);
    // 播客 CDN：跳转跟随会真正 GET 音频地址（落定响应的 body 被 Worker 立刻取消）
    if (/^https:\/\/(cdn|stats|podcast)\.example\.com\//.test(url)) return new Response("fake-audio-bytes", { status: 200 });
    return cloud.fetch(input, init);
  }) as typeof fetch;
}

async function setup(seed: TaskSeed = {}, poll = FAST_POLL) {
  const cloud = makeCloud();
  Object.assign(cloud.env, { TRANSCRIPTION_PROVIDER: "dashscope", DASHSCOPE_API_KEY: API_KEY });
  const ds = new FakeDashScope(false);
  insertTask(cloud.d1, { status: "queued", ...seed });
  await cloud.workflow.create({ id: INSTANCE, params: paramsFor() });
  const fetchFn = route(cloud, ds);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchFn; // GitHub 走全局 fetch（与生产一致）
  const engine = new DurableStepEngine();
  const run = (step: DurableStepEngine = engine) => runProcessingPipeline(cloud.env, paramsFor(), INSTANCE, step, { fetchFn, poll });
  return {
    cloud,
    ds,
    engine,
    run,
    cleanup: () => {
      globalThis.fetch = realFetch;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

async function failure(promise: Promise<unknown>): Promise<TranscriptionServiceError> {
  try {
    await promise;
  } catch (error) {
    return error as TranscriptionServiceError;
  }
  throw new Error("expected a failure");
}

const submit = (env: unknown, ds: FakeDashScope, url = AUDIO_URL, options?: { language?: string }) =>
  submitDashscopeTranscription(env as never, "t:a", { type: "url", url }, options, ds.fetch);

describe("提交：POST 异步任务端点", () => {
  it("POST /services/audio/asr/transcription：Bearer 鉴权、X-DashScope-Async、单文件 file_urls、paraformer-v2", async () => {
    const ds = new FakeDashScope();
    const snapshot = await submit(dashEnv(), ds);

    const [post] = ds.posts;
    expect(post.path).toBe("/api/v1/services/audio/asr/transcription");
    expect(post.authorization).toBe(`Bearer ${API_KEY}`);
    expect(post.asyncHeader).toBe("enable");
    expect(post.body).toEqual({ model: "paraformer-v2", input: { file_urls: [AUDIO_URL] } });
    expect(snapshot).toMatchObject({ request_id: "t:a", provider_request_id: "dash-task-1", status: "queued" });
  });

  it("TRANSCRIPTION_LANGUAGE 随 parameters.language_hints 下发（仅 paraformer-v2 支持）", async () => {
    const ds = new FakeDashScope();
    await submit(dashEnv(), ds, AUDIO_URL, { language: "zh" });
    expect(ds.posts[0].body.parameters).toEqual({ language_hints: ["zh"] });
  });

  it("缺少 DASHSCOPE_API_KEY → unconfigured（non-retryable，可行动的部署错误）", async () => {
    const error = await failure(submit(dashEnv({ DASHSCOPE_API_KEY: "" }), new FakeDashScope()));
    expect(error).toMatchObject({ code: "transcription_service_unconfigured", retryable: false });
  });

  it.each([
    [401, "transcription_service_auth", false],
    [403, "transcription_service_auth", false],
    [400, "transcription_request_rejected", false],
    [429, "transcription_service_unavailable", true],
    [500, "transcription_service_unavailable", true],
    [503, "transcription_service_unavailable", true],
  ])("HTTP %i → %s（retryable=%s）", async (status, code, retryable) => {
    const ds = new FakeDashScope();
    ds.submitStatuses = [status];
    const error = await failure(submit(dashEnv(), ds));
    expect(error).toMatchObject({ code, retryable, status });
  });

  it("离线 → unreachable（retryable）；提交响应缺少 task_id → protocol error", async () => {
    const offline = new FakeDashScope();
    offline.offline = true;
    expect(await failure(submit(dashEnv(), offline))).toMatchObject({ kind: "unreachable", retryable: true });

    const bad = await failure(
      submitDashscopeTranscription(
        dashEnv(),
        "t:a",
        { type: "url", url: AUDIO_URL },
        undefined,
        (async () => Response.json({ output: { task_status: "PENDING" } })) as unknown as typeof fetch,
      ),
    );
    expect(bad).toMatchObject({ code: "transcription_protocol_error", retryable: false });
  });
});

describe("查询：状态翻译与错误码映射", () => {
  const ref = { requestId: "t:a", providerRequestId: "dash-task-1" };
  const pollWith = (ds: FakeDashScope, waitSeconds = 0) => pollDashscopeTranscription(dashEnv(), ref, waitSeconds, ds.fetch);

  it("PENDING → queued；RUNNING → running（transcribing 0%，百炼没有进度百分比）", async () => {
    const ds = new FakeDashScope();
    expect(await pollWith(ds)).toMatchObject({ status: "queued" });
    expect(await pollWith(ds)).toMatchObject({ status: "running", progress: { phase: "transcribing", percent: 0 } });
    expect(await pollWith(ds)).toMatchObject({ status: "completed" });
  });

  it("404 = 百炼不认识该任务 → null（交给 Workflow 重新提交）", async () => {
    const ds = new FakeDashScope();
    expect(await pollDashscopeTranscription(dashEnv(), { requestId: "t:a", providerRequestId: "dash-task-999" }, 0, ds.fetch)).toBeNull();
  });

  it("FAILED：取不到音频 → provider_fetch_failed（确定性失败）", async () => {
    const ds = new FakeDashScope();
    ds.failWith = { message: "InvalidFile.DownloadFailed: The audio file download failed" };
    const snapshot = await pollWith(ds);
    expect(snapshot).toMatchObject({ status: "failed", error: { code: "provider_fetch_failed" } });
    expect(NON_RETRYABLE_PROVIDER_ERRORS.has("provider_fetch_failed")).toBe(true);
    expect(taskErrorCodeForProvider("provider_fetch_failed")).toBe("provider_audio_fetch_failed");
  });

  it("FAILED：额度用尽 → provider_quota_exhausted（确定性失败）", async () => {
    const ds = new FakeDashScope();
    ds.failWith = { code: "AllocationQuota", message: "Free quota exhausted" };
    expect(await pollWith(ds)).toMatchObject({ status: "failed", error: { code: "provider_quota_exhausted" } });
    expect(NON_RETRYABLE_PROVIDER_ERRORS.has("provider_quota_exhausted")).toBe(true);
    expect(taskErrorCodeForProvider("provider_quota_exhausted")).toBe("provider_quota_exhausted");
  });

  it("FAILED：其他原因保持可重试（重新提交是 Workflow 的既定路径）", async () => {
    const ds = new FakeDashScope();
    ds.failWith = { code: "InternalError", message: "InternalError: weird" };
    expect(await pollWith(ds)).toMatchObject({ status: "failed", error: { code: "transcription_failed" } });
    expect(NON_RETRYABLE_PROVIDER_ERRORS.has("transcription_failed")).toBe(false);
  });

  it("百炼不支持长轮询：仍要进行中时客户端等待 waitSeconds 再返回", async () => {
    vi.useFakeTimers();
    const ds = new FakeDashScope();
    const pending = pollDashscopeTranscription(dashEnv(), ref, 25, ds.fetch);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toMatchObject({ status: "queued" });
    const running = pollDashscopeTranscription(dashEnv(), ref, 25, ds.fetch);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await running).toMatchObject({ status: "running" });
    // 已落定的查询（SUCCEEDED）不等待
    expect(await pollDashscopeTranscription(dashEnv(), ref, 25, ds.fetch)).toMatchObject({ status: "completed" });
  });

  it("providerCodeForDashscopeFailure：下载 / 额度 / 其余三分法", () => {
    expect(providerCodeForDashscopeFailure("", "InvalidFile.DownloadFailed: x")).toBe("provider_fetch_failed");
    expect(providerCodeForDashscopeFailure("", "unsupported format .xyz")).toBe("provider_fetch_failed");
    expect(providerCodeForDashscopeFailure("LimitExceeded", "")).toBe("provider_quota_exhausted");
    expect(providerCodeForDashscopeFailure("", "InternalError")).toBe("transcription_failed");
  });
});

describe("取结果：transcription_url → JSON → 纯文本", () => {
  const ref = { requestId: "t:a", providerRequestId: "dash-task-1" };

  it("SUCCEEDED → 下载结果 JSON，取 transcripts[].text（词级时间戳全部丢弃）", async () => {
    const ds = new FakeDashScope();
    await pollDashscopeTranscription(dashEnv(), ref, 0, ds.fetch);
    await pollDashscopeTranscription(dashEnv(), ref, 0, ds.fetch);
    await pollDashscopeTranscription(dashEnv(), ref, 0, ds.fetch); // → SUCCEEDED

    const text = await fetchDashscopeTranscriptionResult(dashEnv(), ref, ds.fetch);
    expect(text).toBe(RAW_TEXT);
    expect(ds.resultFetches).toBe(1);
  });

  it("transcripts[].text 缺失时回退到 sentences 拼接；多音轨段落以空行连接", async () => {
    const ds = new FakeDashScope();
    ds.resultJson = {
      properties: { original_duration_in_milliseconds: 12000 },
      transcripts: [
        { sentences: [{ text: "第一段。" }, { text: "第二句。" }] },
        { text: "第二音轨。" },
      ],
    };
    // 直接构造一个已 SUCCEEDED 的查询路径（phases 耗尽即可）
    await pollDashscopeTranscription(dashEnv(), ref, 0, ds.fetch);
    await pollDashscopeTranscription(dashEnv(), ref, 0, ds.fetch);
    await pollDashscopeTranscription(dashEnv(), ref, 0, ds.fetch);
    expect(await fetchDashscopeTranscriptionResult(dashEnv(), ref, ds.fetch)).toBe("第一段。第二句。\n\n第二音轨。");
  });

  it("查询时刻已 FAILED / 404 → null（交给 Workflow 重新提交）", async () => {
    const failed = new FakeDashScope();
    failed.failWith = { message: "InternalError" };
    expect(await fetchDashscopeTranscriptionResult(dashEnv(), ref, failed.fetch)).toBeNull();

    const unknown = new FakeDashScope();
    expect(await fetchDashscopeTranscriptionResult(dashEnv(), { requestId: "t:a", providerRequestId: "dash-task-999" }, unknown.fetch)).toBeNull();
  });

  it("结果 JSON 超过 16 MiB 上限 → transcription_response_too_large（non-retryable，复用 raw_too_large 归因）", async () => {
    const ds = new FakeDashScope();
    ds.resultJson = { transcripts: [{ text: "x".repeat(17 * 1024 * 1024) }] };
    await pollDashscopeTranscription(dashEnv(), ref, 0, ds.fetch);
    await pollDashscopeTranscription(dashEnv(), ref, 0, ds.fetch);
    await pollDashscopeTranscription(dashEnv(), ref, 0, ds.fetch);
    const error = await failure(fetchDashscopeTranscriptionResult(dashEnv(), ref, ds.fetch));
    expect(error).toMatchObject({ code: "transcription_response_too_large", retryable: false });
  });

  it("SUCCEEDED 却没有 transcription_url → protocol error", async () => {
    const ds = new FakeDashScope();
    ds.phases = []; // 查询即 SUCCEEDED
    // 用自定义 fetch 包一层：剥掉 SUCCEEDED 响应里的 results
    const stripped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await ds.fetch(input, init);
      if (String(input).startsWith(DASHSCOPE_BASE_URL)) {
        const body = (await response.json()) as { output: { results?: unknown } };
        delete body.output.results;
        return Response.json(body);
      }
      return response;
    }) as unknown as typeof fetch;
    const error = await failure(fetchDashscopeTranscriptionResult(dashEnv(), ref, stripped));
    expect(error).toMatchObject({ code: "transcription_protocol_error", retryable: false });
  });
});

describe("provider 分发与探针", () => {
  it("默认（未设置 TRANSCRIPTION_PROVIDER）走自托管路径", async () => {
    const cloud = makeCloud();
    expect(transcriptionProvider(cloud.env)).toBe("self-hosted");
    const snapshot = await submitTranscription(cloud.env, { request_id: "t:a", source: { type: "url", url: AUDIO_URL } }, cloud.fetch);
    expect(snapshot.provider_request_id).toBe("tsr_0001");
    expect(cloud.service.posts).toHaveLength(1);
  });

  it("显式 dashscope 才走适配器；其他值显式报错（不静默回落）", async () => {
    expect(transcriptionProvider(dashEnv())).toBe("dashscope");
    const error = await failure(Promise.resolve().then(() => transcriptionProvider(dashEnv({ TRANSCRIPTION_PROVIDER: "openai" }))));
    expect(error).toMatchObject({ code: "transcription_provider_unknown", retryable: false });
  });

  it("dashscope 探针只验证密钥配置，不实际调用服务商（无计费副作用）", async () => {
    expect(await checkServiceHealth(dashEnv())).toMatchObject({ ok: true, engine: "dashscope-paraformer" });
    expect(await checkServiceHealth(dashEnv({ DASHSCOPE_API_KEY: "" }))).toMatchObject({ ok: false });
    const invalid = await checkServiceHealth(dashEnv({ TRANSCRIPTION_PROVIDER: "openai" }));
    expect(invalid.ok).toBe(false);
    expect(invalid.detail).toContain("TRANSCRIPTION_PROVIDER");
  });
});

describe("RSS 跳转跟随（仅云端服务商路径）", () => {
  const hops = (chain: Array<{ status: number; location?: string }>, finalStatus = 200) => {
    let hop = 0;
    return (async () => {
      const step = chain[hop];
      if (step) {
        hop += 1;
        return new Response(null, { status: step.status, headers: step.location ? { location: step.location } : {} });
      }
      return new Response("audio-bytes", { status: finalStatus });
    }) as unknown as typeof fetch;
  };

  it("跟随 302 到最终地址；落定响应的 body 被立刻取消（音频不经过 Worker）", async () => {
    const fetchFn = hops([
      { status: 302, location: "https://stats.example.com/redirect?a=1" },
      { status: 301, location: "https://cdn.example.com/a.mp3" },
    ]);
    expect(await resolveFinalAudioUrl("https://podcast.example.com/a.mp3", fetchFn)).toBe("https://cdn.example.com/a.mp3");
  });

  it("相对 Location 与无 Location 的 3xx 都能处理", async () => {
    const relative = hops([{ status: 302, location: "../media/a.mp3" }]);
    expect(await resolveFinalAudioUrl("https://podcast.example.com/ep/1/", relative)).toBe("https://podcast.example.com/ep/media/a.mp3");
    const noLocation = hops([{ status: 302 }]);
    expect(await resolveFinalAudioUrl("https://podcast.example.com/a.mp3", noLocation)).toBe("https://podcast.example.com/a.mp3");
  });

  it("跳转链耗尽 / 私网跳转 → source_not_allowed", async () => {
    const loop = hops(Array.from({ length: 8 }, () => ({ status: 302, location: "https://stats.example.com/next" })));
    await expect(resolveFinalAudioUrl("https://podcast.example.com/a.mp3", loop)).rejects.toMatchObject({ code: "source_not_allowed" });

    const privateHop = hops([{ status: 302, location: "http://10.0.0.5/a.mp3" }]);
    await expect(resolveFinalAudioUrl("https://podcast.example.com/a.mp3", privateHop)).rejects.toMatchObject({ code: "source_not_allowed" });
  });

  it("dashscope + RSS：resolve-source 解析出最终地址；self-hosted 不做跳转跟随", async () => {
    const fetchFn = vi.fn(hops([{ status: 302, location: "https://cdn.example.com/a.mp3" }]));
    const cloud = makeCloud();
    Object.assign(cloud.env, { TRANSCRIPTION_PROVIDER: "dashscope", DASHSCOPE_API_KEY: API_KEY });
    const source = await resolveTranscriptionSource(cloud.env, { source_type: "rss", audio_url: "https://podcast.example.com/a.mp3" }, Date.now(), undefined, fetchFn as unknown as typeof fetch);
    expect(source).toEqual({ type: "url", url: "https://cdn.example.com/a.mp3" });
    expect(fetchFn).toHaveBeenCalledTimes(2); // 302 一跳 + 落定响应

    const selfHosted = makeCloud();
    const never = vi.fn();
    expect(await resolveTranscriptionSource(selfHosted.env, { source_type: "rss", audio_url: "https://cdn.example.com/a.mp3" }, Date.now(), undefined, never as unknown as typeof fetch)).toEqual({
      type: "url",
      url: "https://cdn.example.com/a.mp3",
    });
    expect(never).not.toHaveBeenCalled();
  });

  it("dashscope + 上传：presigned URL 原样使用（不做跳转解析）", async () => {
    const cloud = makeCloud();
    Object.assign(cloud.env, { TRANSCRIPTION_PROVIDER: "dashscope", DASHSCOPE_API_KEY: API_KEY });
    cloud.r2.putSized("uploads/up-1/talk.mp3", 4_096);
    const never = vi.fn();
    const source = await resolveTranscriptionSource(cloud.env, { source_type: "upload", audio_url: "r2://uploads/up-1/talk.mp3" }, Date.now(), undefined, never as unknown as typeof fetch);
    expect(source.type).toBe("url");
    expect(source.url).toContain("r2.cloudflarestorage.com");
    expect(never).not.toHaveBeenCalled();
  });
});

describe("Workflow 集成（dashscope）：提交 → 轮询 → raw 落 R2", () => {
  it("从 queued 一路走到 success：raw 正文来自结果 JSON，提交恰好一次", async () => {
    const { cloud, ds, run, cleanup } = await setup();
    try {
      const result = await run();

      expect(result.finalPath).toContain("podcasts/transcripts/");
      expect(taskRow(cloud.d1)).toMatchObject({ status: "success", raw_object_key: RAW_KEY, provider_request_id: "dash-task-1" });
      expect(await (await cloud.r2.get(RAW_KEY))!.text()).toBe(RAW_TEXT);
      expect(ds.posts).toHaveLength(1);
      expect(ds.queries.length).toBeGreaterThanOrEqual(4); // 轮询 + persist 复核 + 取结果前的查询
      expect(ds.resultFetches).toBe(1);
      // 自托管假服务完全未被触碰
      expect(cloud.service.log).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("取不到音频 → provider_audio_fetch_failed，用户可见文案建议改用自托管；不重复提交", async () => {
    const { cloud, ds, run, cleanup } = await setup();
    try {
      ds.failWith = { message: "InvalidFile.DownloadFailed: The audio file download failed" };
      await expect(run()).rejects.toThrow("[provider_audio_fetch_failed]");
      expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "provider_audio_fetch_failed" });
      expect(taskRow(cloud.d1).message).toContain("自托管");
      expect(ds.posts).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("额度用尽 → provider_quota_exhausted", async () => {
    const { cloud, ds, run, cleanup } = await setup();
    try {
      ds.failWith = { code: "AllocationQuota", message: "Free quota exhausted" };
      await expect(run()).rejects.toThrow("[provider_quota_exhausted]");
      expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "provider_quota_exhausted" });
      expect(ds.posts).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("其他 FAILED 保持可重试语义：3 次 submission 后收敛为 transcription_failed", async () => {
    const { cloud, ds, run, cleanup } = await setup();
    try {
      ds.failWith = { code: "InternalError", message: "InternalError: weird" };
      await expect(run()).rejects.toThrow("[transcription_failed]");
      expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "transcription_failed" });
      expect(ds.posts).toHaveLength(3);
    } finally {
      cleanup();
    }
  });

  it("重放幂等：同一份 checkpoint 上重放，所有 step 命中缓存——没有第二次提交", async () => {
    const { cloud, ds, engine, run, cleanup } = await setup();
    try {
      await run();
      const replayed = engine.replay();
      await run(replayed);
      expect(replayed.executed).toEqual([]);
      expect(ds.posts).toHaveLength(1);
      expect(taskRow(cloud.d1)).toMatchObject({ status: "success" });
    } finally {
      cleanup();
    }
  });

  it("isolate 在提交成功后、checkpoint 前崩溃：重放复用 D1 里的 provider 句柄，不创建第二个百炼任务", async () => {
    const { cloud, ds, engine, run, cleanup } = await setup();
    try {
      engine.crashAfter.add(submitStepName(1));
      await expect(run()).rejects.toBeInstanceOf(IsolateCrash);
      expect(ds.posts).toHaveLength(1);
      expect(taskRow(cloud.d1).provider_request_id).toBe("dash-task-1");

      const replay = engine.replay();
      await run(replay);
      expect(ds.posts).toHaveLength(1); // 复用 D1 句柄，百炼没有幂等键——绝不重复提交
      expect(taskRow(cloud.d1)).toMatchObject({ status: "success", raw_object_key: RAW_KEY, provider_request_id: "dash-task-1" });
    } finally {
      cleanup();
    }
  });

  it("上传任务：发给百炼的是 R2 presigned URL，raw 正常落 R2", async () => {
    const { cloud, ds, run, cleanup } = await setup({ source_type: "upload", audio_url: "r2://uploads/up-1/talk.mp3", episode_id: null });
    try {
      await cloud.r2.put("uploads/up-1/talk.mp3", new Uint8Array([1, 2, 3, 4]));
      await run();
      expect(taskRow(cloud.d1)).toMatchObject({ status: "success" });
      const sentUrl = ds.posts[0].body.input.file_urls[0] as string;
      expect(sentUrl).toContain("r2.cloudflarestorage.com");
      expect(sentUrl).toContain("X-Amz-Signature=");
    } finally {
      cleanup();
    }
  });



  it("提交响应丢失（百炼已接收）：durable retry 会创建第二个任务（无幂等键的已知限制，见 ARCHITECTURE）", async () => {
    const { cloud, ds, engine, run, cleanup } = await setup();
    try {
      ds.dropSubmitResponses = 1;
      await run();
      expect(engine.attempts[submitStepName(1)]).toBe(2);
      expect(ds.posts.length).toBeGreaterThanOrEqual(2); // 第一个任务成为孤儿，24h 后被服务商回收
      expect(taskRow(cloud.d1)).toMatchObject({ status: "success" });
    } finally {
      cleanup();
    }
  });
});

describe("SourceError 仍是确定性失败（云端路径同样适用）", () => {
  it("私网音频 URL 在预检阶段就被拒绝", async () => {
    const { cloud, ds, run, cleanup } = await setup({ audio_url: "http://10.0.0.5/a.mp3" });
    try {
      await expect(run()).rejects.toThrow("[source_not_allowed]");
      expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "source_not_allowed" });
      expect(ds.posts).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
