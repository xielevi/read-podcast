/**
 * ProcessingWorkflow 管线：Cloudflare 从任务创建起拥有整条 durable 主链
 *   resolve-raw → 转录（提交 → 长轮询 → raw 落 R2）→ 精修 → 质量门禁 → 成稿 → success。
 *
 * 全部跑在真实 SQLite 上（CAS 守卫 / CHECK / 唯一索引都是真的），转录服务是一个只通过 HTTP 触达的
 * 协议级假实现——Cloudflare 侧对它一无所知，正是「换一台转录机器」的验收形态。
 *
 * 覆盖：服务离线 / 超时 / 5xx / 非重试错误 / 服务丢请求 / provider 卡死 / stale 与 duplicate 结果 /
 * 取消与结果竞态 / raw 后重试不重转 / 精修与 publish 重试不重复昂贵步骤 / replay 幂等 / RSS 与上传源。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelOrDeleteTask, retryTask, toPublicTask } from "../src/tasks";
import { exponentialRetryDelay, nonRetryable, workflowError } from "../src/workflows/common";
import { classifyFailure, errorCodeOf, runProcessingPipeline, CLAIM_STEP, PUBLISH_STEP, REFINE_STEP } from "../src/workflows/pipeline";
import { processingWorkflowId } from "../src/workflows/processing";
import {
  MAX_SUBMISSIONS,
  SUBMIT_RETRY_LIMIT,
  backoffStepName,
  persistStepName,
  pollStepName,
  releaseStepName,
  resolveSourceStepName,
  submitStepName,
  persistRawStep,
} from "../src/workflows/transcription";
import { rawObjectKey } from "../src/raw";
import { MAX_UPLOAD_BYTES } from "../src/limits";
import { PRESIGNED_SOURCE_TTL_SECONDS } from "../src/transcription/r2_presign";
import { resolveTranscriptionSource } from "../src/transcription/source";
import { submitTranscription } from "../src/transcription/client";
import { TranscriptionServiceError } from "../src/transcription/contract";
import {
  ACCESS_CLIENT_ID,
  ACCESS_CLIENT_SECRET,
  ATTEMPT,
  DurableStepEngine,
  FAST_POLL,
  IsolateCrash,
  R2_ACCOUNT_ID,
  R2_BUCKET,
  R2_SECRET_ACCESS_KEY,
  isEngineNonRetryable,
  presignedParts,
  RAW_TEXT,
  SERVICE_URL,
  TASK,
  ctxStub,
  insertTask,
  makeCloud,
  paramsFor,
  taskRow,
  type Cloud,
  type TaskSeed,
} from "./helpers/cloud";

const INSTANCE = processingWorkflowId(TASK, ATTEMPT);
const RAW_KEY = rawObjectKey(TASK, ATTEMPT);
const REFINED_KEY = `refined/${TASK}/${ATTEMPT}.md`;
const realFetch = globalThis.fetch;

async function setup(seed: TaskSeed = {}, poll = FAST_POLL) {
  const cloud = makeCloud();
  insertTask(cloud.d1, { status: "queued", ...seed });
  await cloud.workflow.create({ id: INSTANCE, params: paramsFor() });
  globalThis.fetch = cloud.fetch; // GitHub 走全局 fetch（与生产一致）
  const engine = new DurableStepEngine();
  const run = (step: DurableStepEngine = engine, attempt = ATTEMPT, instance = INSTANCE) =>
    runProcessingPipeline(cloud.env, paramsFor(TASK, attempt), instance, step, { fetchFn: cloud.fetch, poll });
  return { cloud, engine, run };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const articleCount = (cloud: Cloud) => (cloud.d1.raw.prepare("SELECT COUNT(*) AS n FROM articles").get() as { n: number }).n;
const rawObjects = (cloud: Cloud) => cloud.r2.keys("raw/");
const submitSteps = (engine: DurableStepEngine) => engine.executed.filter(name => name.startsWith("submit-transcription-"));

describe("主链：Cloudflare 驱动转录 → raw → 精修 → 成稿", () => {
  it("从 queued 一路走到 success；转录服务只被当作外部计算调用", async () => {
    const { cloud, engine, run } = await setup();

    const result = await run();

    expect(result.finalPath).toContain("podcasts/transcripts/");
    expect(taskRow(cloud.d1)).toMatchObject({ status: "success", progress: 100, error_code: null, current_attempt_id: ATTEMPT });
    // raw：R2 里恰好一份，键由 (task, attempt) 确定；D1 记录同一个键
    expect(rawObjects(cloud)).toEqual([RAW_KEY]);
    expect(taskRow(cloud.d1).raw_object_key).toBe(RAW_KEY);
    // R2 raw 在 refineStep 中只读取一次，publishStep 读取 refined checkpoint，不重复读取 R2
    expect(cloud.r2.getLog.filter(k => k.startsWith("raw/"))).toEqual([RAW_KEY]);
    expect(cloud.r2.keys("refined/")).toEqual([REFINED_KEY]);
    expect(await (await cloud.r2.get(REFINED_KEY))!.text()).toBe(cloud.externals.refinedText);
    // 每个昂贵步骤各一次
    expect(cloud.service.posts).toHaveLength(1);
    expect(cloud.externals.llmCalls).toBe(1);
    expect(cloud.externals.github.commits).toBe(1);
    expect(articleCount(cloud)).toBe(1);
    // step 顺序：先解析 raw，再转录，再精修，最后发布
    const order = engine.executed;
    expect(order.indexOf("resolve-raw")).toBeLessThan(order.indexOf("start-transcription"));
    // source 必须在 submit **之前**、且作为独立的 durable step 解析（同一 submission 内 URL 因此恒定）
    expect(order.indexOf(resolveSourceStepName(1))).toBeLessThan(order.indexOf(submitStepName(1)));
    expect(order.indexOf(submitStepName(1))).toBeLessThan(order.indexOf(pollStepName(1, 1)));
    expect(order.indexOf(persistStepName(1))).toBeLessThan(order.indexOf(CLAIM_STEP));
    expect(order.indexOf(CLAIM_STEP)).toBeLessThan(order.indexOf(REFINE_STEP));
    expect(order.indexOf(REFINE_STEP)).toBeLessThan(order.indexOf(PUBLISH_STEP));
    // 转录服务被通知释放资源（尽力）
    expect(engine.executed).toContain(releaseStepName(1));
    expect(cloud.service.deletes).toHaveLength(1);
  });

  it("请求契约：request_id = task:attempt、source 是 URL、带服务令牌；RSS 直接给原始音频 URL", async () => {
    const { cloud, run } = await setup();
    await run();

    const [post] = cloud.service.posts;
    expect(post.path).toBe("/v1/transcriptions");
    expect(post.body).toEqual({ request_id: `${TASK}:${ATTEMPT}`, source: { type: "url", url: "https://cdn.example.com/a.mp3" } });
    // 没有任何 Mac / 共享文件系统 / 本机路径概念
    expect(JSON.stringify(post.body)).not.toMatch(/mac|launchd|\/Users\/|file:/i);
  });

  it("可选的转录选项随请求下发", async () => {
    const { cloud, run } = await setup();
    (cloud.env as unknown as Record<string, string>).TRANSCRIPTION_LANGUAGE = "zh";
    await run();
    expect(cloud.service.posts[0].body.options).toEqual({ language: "zh" });
  });

  it("进度镜像：转录服务上报子阶段，Cloudflare 映射为全局进度与公开 stage", async () => {
    const { cloud, engine, run } = await setup();
    const seen: Array<Record<string, any>> = [];
    engine.after.set(submitStepName(1), () => void seen.push({ ...taskRow(cloud.d1) }));
    engine.after.set(pollStepName(1, 1), () => void seen.push({ ...taskRow(cloud.d1) }));

    await run();

    // 提交后：获取音频阶段 → 公开 stage=downloading
    expect(seen[0]).toMatchObject({ status: "transcribing", transcription_phase: "fetching", provider_request_id: "tsr_0001" });
    expect(toPublicTask(seen[0] as never)).toMatchObject({ status: "running", stage: "downloading" });
    // 第一个 poll 窗口结束（3 次轮询）：转录阶段 80%（25 + 0.8 × 40 = 57）
    expect(seen[1]).toMatchObject({ status: "transcribing", transcription_phase: "transcribing", progress: 57 });
    expect(seen[1].message).toContain("语音转录中 80%");
    expect(toPublicTask(seen[1] as never)).toMatchObject({ status: "running", stage: "transcribing", progress_pct: 57 });
  });

  it("进度全局单调：转录进度不会被后到的较小值回退", async () => {
    const { cloud, run } = await setup();
    cloud.service.steps = [
      { phase: "transcribing", percent: 80 },
      { phase: "transcribing", percent: 20 },
      "done",
    ];
    await run();
    expect(taskRow(cloud.d1).progress).toBe(100);
  });
});

describe("转录服务不可用：durable retry 由 Cloudflare 判断", () => {
  it("服务离线：任务保持权威，退避重试；服务恢复后自动继续，不需要任何 reclaim", async () => {
    const { cloud, engine, run } = await setup();
    cloud.service.offline = true;
    const messages: string[] = [];
    engine.before.set(submitStepName(1), () => {
      if (engine.attempts[submitStepName(1)] >= 4) cloud.service.offline = false; // 第 4 次尝试前服务恢复
      messages.push(taskRow(cloud.d1).message);
    });

    await run();

    expect(engine.attempts[submitStepName(1)]).toBe(4);
    expect(messages[1]).toBe("转录服务暂不可用，将自动重试（第 1 次）");
    expect(messages[2]).toBe("转录服务暂不可用，将自动重试（第 2 次）");
    expect(taskRow(cloud.d1).status).toBe("success");
    expect(cloud.service.posts).toHaveLength(1);
  });

  it("服务长时间不可用：耗尽 durable retry 后转 error（可重试），不丢任务", async () => {
    const { cloud, engine, run } = await setup();
    cloud.service.offline = true;

    await expect(run()).rejects.toThrow("[transcription_service_unavailable]");

    expect(engine.attempts[submitStepName(1)]).toBe(SUBMIT_RETRY_LIMIT + 1);
    expect(taskRow(cloud.d1)).toMatchObject({
      status: "error",
      error_code: "transcription_service_unavailable",
      message: "转录服务长时间不可用，请确认服务已启动后重试",
    });
    expect(cloud.externals.llmCalls).toBe(0);
    expect(rawObjects(cloud)).toEqual([]);
  });

  it("连接 / 响应超时属于 retryable，并给出对应提示", async () => {
    const { cloud, engine, run } = await setup();
    cloud.service.transportError = new DOMException("The operation timed out", "TimeoutError");
    const messages: string[] = [];
    engine.before.set(submitStepName(1), () => {
      messages.push(taskRow(cloud.d1).message);
      if (engine.attempts[submitStepName(1)] >= 2) cloud.service.transportError = null;
    });

    await run();

    expect(messages[1]).toBe("转录服务响应超时，将自动重试（第 1 次）");
    expect(taskRow(cloud.d1).status).toBe("success");
  });

  it("5xx / 429 属于 retryable：重试后成功，且只产生一个转录请求", async () => {
    const { cloud, engine, run } = await setup();
    cloud.service.submitStatuses = [503, 502, 429];

    await run();

    expect(engine.attempts[submitStepName(1)]).toBe(4);
    expect(taskRow(cloud.d1).status).toBe("success");
    expect(cloud.service.jobs.size).toBe(1);
  });

  it("轮询阶段的瞬时故障同样由 durable retry 吸收，不重新提交", async () => {
    const { cloud, engine, run } = await setup();
    cloud.service.pollStatuses = [503, 503];

    await run();

    expect(engine.attempts[pollStepName(1, 1)]).toBe(3);
    expect(cloud.service.posts).toHaveLength(1);
    expect(taskRow(cloud.d1).status).toBe("success");
  });

  it.each([
    ["403 Access 拒绝", (c: Cloud) => void (c.env.CF_ACCESS_CLIENT_SECRET = "wrong"), "transcription_service_auth"],
    ["服务地址未配置", (c: Cloud) => void (c.env.TRANSCRIPTION_SERVICE_URL = ""), "transcription_service_unconfigured"],
    ["Access 凭据未配置", (c: Cloud) => void (c.env.CF_ACCESS_CLIENT_ID = ""), "transcription_service_unconfigured"],
    ["422 请求被拒", (c: Cloud) => void (c.service.submitStatuses = [422]), "transcription_request_rejected"],
    ["400 请求被拒", (c: Cloud) => void (c.service.submitStatuses = [400]), "transcription_request_rejected"],
    ["404（端点不存在）", (c: Cloud) => void (c.service.submitStatuses = [404]), "transcription_request_rejected"],
  ])("非重试错误（%s）：立即失败，不重试、不重复提交", async (_label, configure, code) => {
    const { cloud, engine, run } = await setup();
    configure(cloud);

    await expect(run()).rejects.toThrow(`[${code}]`);

    expect(engine.attempts[submitStepName(1)]).toBe(1);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: code });
    expect(cloud.externals.llmCalls).toBe(0);
  });

  it("响应的 request_id 不属于本次提交（串线 / 陈旧响应）：拒绝并报协议错误", async () => {
    const { cloud, run } = await setup();
    cloud.service.mutateSnapshot = snapshot => ({ ...snapshot, request_id: "other-task:other-attempt" });

    await expect(run()).rejects.toThrow("[transcription_protocol_error]");

    expect(taskRow(cloud.d1).error_code).toBe("transcription_protocol_error");
    expect(rawObjects(cloud)).toEqual([]);
  });
});

describe("服务丢失请求 / provider 失败 / 超时：由 Cloudflare 决定是否重新提交", () => {
  it("服务重启丢了请求（轮询 404）→ 重新提交并完成；最终只有一份 raw", async () => {
    const { cloud, engine, run } = await setup();
    engine.after.set(pollStepName(1, 1), () => cloud.service.restart());

    await run();

    expect(cloud.service.posts).toHaveLength(2);
    expect(cloud.service.posts[0].body.request_id).toBe(cloud.service.posts[1].body.request_id);
    expect(engine.sleeps).toContain(backoffStepName(1));
    expect(engine.executed).toContain(submitStepName(2));
    expect(rawObjects(cloud)).toEqual([RAW_KEY]);
    expect(taskRow(cloud.d1).status).toBe("success");
    expect(cloud.externals.llmCalls).toBe(1);
  });

  it(`连续 ${MAX_SUBMISSIONS} 次丢请求 → 转 error（transcription_failed），不无限重提`, async () => {
    const { cloud, engine, run } = await setup();
    for (let n = 1; n <= MAX_SUBMISSIONS; n += 1) engine.after.set(pollStepName(n, 1), () => cloud.service.restart());

    await expect(run()).rejects.toThrow("[transcription_failed]");

    expect(cloud.service.posts).toHaveLength(MAX_SUBMISSIONS);
    expect(submitSteps(engine)).toHaveLength(MAX_SUBMISSIONS);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "transcription_failed" });
  });

  it("provider 报告的可重试失败（引擎暂不可用）→ 重新提交；耗尽后 transcription_failed", async () => {
    const { cloud, run } = await setup();
    cloud.service.failWith = { code: "engine_unavailable" };

    await expect(run()).rejects.toThrow("[transcription_failed]");

    expect(cloud.service.posts).toHaveLength(MAX_SUBMISSIONS);
  });

  it("provider 首次失败、第二次成功 → 任务成功", async () => {
    const { cloud, engine, run } = await setup();
    cloud.service.failWith = { code: "engine_unavailable" };
    engine.after.set(pollStepName(1, 1), () => void (cloud.service.failWith = null));

    await run();

    expect(cloud.service.posts).toHaveLength(2);
    expect(taskRow(cloud.d1).status).toBe("success");
  });

  it.each([
    ["source_too_large", "source_too_large"],
    ["source_not_allowed", "source_not_allowed"],
    ["engine_rejected_audio", "transcription_failed"],
    ["transcription_empty", "transcription_invalid"],
  ])("provider 报告确定性失败（%s）→ 立即终止，不重新提交（error=%s）", async (providerCode, taskCode) => {
    const { cloud, run } = await setup();
    cloud.service.failWith = { code: providerCode };

    await expect(run()).rejects.toThrow(`[${taskCode}]`);

    expect(cloud.service.posts).toHaveLength(1);
    expect(taskRow(cloud.d1).error_code).toBe(taskCode);
  });

  it("取不到音频（source_fetch_failed）在重提耗尽后归因为 audio_download_failed", async () => {
    const { cloud, run } = await setup();
    cloud.service.failWith = { code: "source_fetch_failed" };

    await expect(run()).rejects.toThrow("[audio_download_failed]");

    expect(cloud.service.posts).toHaveLength(MAX_SUBMISSIONS);
  });

  it("provider 卡死超过最长等待：取消并重新提交，耗尽后 transcription_timeout（由 Cloudflare 判断，不靠服务自报）", async () => {
    const { cloud, run } = await setup({}, { ...FAST_POLL, maxTranscriptionMs: -1 });
    cloud.service.hang = true;

    await expect(run()).rejects.toThrow("[transcription_timeout]");

    expect(cloud.service.posts).toHaveLength(MAX_SUBMISSIONS);
    expect(cloud.service.deletes).toHaveLength(MAX_SUBMISSIONS); // 每次超时都尽力取消远端计算
    expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "transcription_timeout" });
  });
});

describe("durable source：URL 的生命周期对应 submission，不对应 HTTP attempt", () => {
  const uploadSeed: TaskSeed = { source_type: "upload", audio_url: "r2://uploads/up-1/talk.mp3", episode_id: null };

  it("provider 已接收 submit、Cloudflare 丢失响应 → durable retry 必须复用同一个 source URL（否则 409）", async () => {
    const { cloud, engine, run } = await setup(uploadSeed);
    await cloud.r2.put("uploads/up-1/talk.mp3", new Uint8Array([1, 2, 3, 4]));
    // 第一次 POST 已经被服务接收并创建了请求，但响应没能回到 Cloudflare（transport error / response timeout）
    cloud.service.dropSubmitResponses = 1;

    await run();

    // 提交被真正重试了（同一个 step 执行了两次）……
    expect(engine.attempts[submitStepName(1)]).toBe(2);
    expect(cloud.service.posts.length).toBeGreaterThanOrEqual(2);
    // ……但两次送出的是**完全相同**的 source URL：没有 request_conflict，也就没有第二次计算
    expect(new Set(cloud.service.posts.map(entry => entry.body.source.url)).size).toBe(1);
    expect(cloud.service.jobs.size).toBe(1);
    expect(cloud.service.counter).toBe(1);
    expect(cloud.service.resultFetches).toBe(1);
    expect(engine.executed).not.toContain(submitStepName(2));
    expect(taskRow(cloud.d1)).toMatchObject({ status: "success", error_code: null });
    expect(rawObjects(cloud)).toEqual([RAW_KEY]);
  });

  it("反证：同一 request_id 换一个 source URL，真实语义就是 409 request_conflict（所以不能每次 retry 重签）", async () => {
    const cloud = makeCloud();
    cloud.r2.putSized("uploads/up-1/talk.mp3", 4_096);
    const task = { source_type: "upload" as const, audio_url: "r2://uploads/up-1/talk.mp3" };
    const first = await resolveTranscriptionSource(cloud.env, task, 1_000_000);
    const second = await resolveTranscriptionSource(cloud.env, task, 2_000_000);
    expect(first.url).not.toBe(second.url); // 重新解析一定得到不同的签名 URL

    const requestId = `${TASK}:${ATTEMPT}`;
    await submitTranscription(cloud.env, { request_id: requestId, source: first }, cloud.fetch);
    const error = await submitTranscription(cloud.env, { request_id: requestId, source: second }, cloud.fetch).then(
      () => null,
      (caught: TranscriptionServiceError) => caught,
    );
    expect(error).toMatchObject({ code: "transcription_request_rejected", retryable: false, status: 409 });
    expect(cloud.service.jobs.size).toBe(1);
  });

  it("provider 真丢了请求（服务重启）→ 进入 submission-2 并重新解析 source，不触发 409", async () => {
    const { cloud, engine, run } = await setup(uploadSeed);
    await cloud.r2.put("uploads/up-1/talk.mp3", new Uint8Array([1, 2, 3, 4]));
    // 第一次提交之后服务重启：运行态请求全部消失，轮询 404 → 判定 provider 丢了请求
    engine.before.set(pollStepName(1, 1), () => cloud.service.restart());

    await run();

    // source 是**每次 submission 重新解析**的（不是跨 submission 复用同一个 checkpoint）。
    // 重新解析落在新的时间戳上时就会得到不同的签名 URL——这正是 submission-2 允许的（它对应一个新的
    // provider 请求）；而同一 submission 内 URL 必须恒定（见上一个用例）。两次解析恰好落在同一秒时
    // URL 可以相同，所以这里断言的是「重新解析发生了」，不是「URL 一定不同」。
    expect(engine.executed).toContain(resolveSourceStepName(1));
    expect(engine.executed).toContain(resolveSourceStepName(2));
    expect(engine.executed).toContain(submitStepName(1));
    expect(engine.executed).toContain(submitStepName(2));
    // 两次提交都成功创建了 provider 请求（第一次那个已随服务重启消失）
    expect(cloud.service.counter).toBe(2);
    for (const post of cloud.service.posts) {
      expect(presignedParts(post.body.source.url).key).toBe(`/${R2_BUCKET}/uploads/up-1/talk.mp3`);
    }
    expect(taskRow(cloud.d1)).toMatchObject({ status: "success", error_code: null });
    expect(rawObjects(cloud)).toEqual([RAW_KEY]);
  });

  it("submission-2 的 URL 可以与前一次不同（旧签名 URL 仍有效时也不影响幂等）", async () => {
    const cloud = makeCloud();
    cloud.r2.putSized("uploads/up-1/talk.mp3", 4_096);
    const task = { source_type: "upload" as const, audio_url: "r2://uploads/up-1/talk.mp3" };
    const at = Date.UTC(2026, 8, 21, 10, 0, 0);
    const first = await resolveTranscriptionSource(cloud.env, task, at);
    const later = await resolveTranscriptionSource(cloud.env, task, at + 90 * 60_000);
    expect(later.url).not.toBe(first.url);
    expect(presignedParts(later.url).key).toBe(presignedParts(first.url).key);
    expect(presignedParts(later.url).params.get("X-Amz-Date")).not.toBe(presignedParts(first.url).params.get("X-Amz-Date"));
  });

  it("resolve-source 是 durable step：replay 不会再解析一次（URL 保持不变、不重新联系 R2）", async () => {
    const { cloud, engine, run } = await setup(uploadSeed);
    await cloud.r2.put("uploads/up-1/talk.mp3", new Uint8Array([1, 2, 3, 4]));

    await run();
    const firstUrl = cloud.service.posts[0].body.source.url;

    // 同一份 checkpoint 上重放：所有已完成 step 直接命中缓存
    const replayed = engine.replay();
    await run(replayed);

    expect(replayed.executed).toEqual([]);
    expect(new Set(cloud.service.posts.map(entry => entry.body.source.url)).size).toBe(1);
    expect(cloud.service.posts[0].body.source.url).toBe(firstUrl);
  });
});

describe("stale / duplicate 结果保护", () => {
  it("attempt 在轮询中被替换：旧 Workflow 立即停止，绝不写 raw，也不覆写新 attempt 的状态", async () => {
    const { cloud, engine, run } = await setup();
    engine.before.set(pollStepName(1, 1), () => {
      cloud.d1.raw.prepare("UPDATE tasks SET current_attempt_id = 'newer-attempt', status = 'queued' WHERE id = ?").run(TASK);
    });

    await expect(run()).rejects.toThrow("[stale_attempt]");

    expect(rawObjects(cloud)).toEqual([]);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "queued", current_attempt_id: "newer-attempt", error_code: null });
    expect(cloud.externals.llmCalls).toBe(0);
  });

  it("结果晚到但 provider 请求已被替换：拒绝成为 raw（stale_provider_request）", async () => {
    const { cloud, engine, run } = await setup();
    engine.before.set(persistStepName(1), () => {
      cloud.d1.raw.prepare("UPDATE tasks SET provider_request_id = 'tsr_other' WHERE id = ?").run(TASK);
    });

    await expect(run()).rejects.toThrow("[stale_provider_request]");

    expect(rawObjects(cloud)).toEqual([]);
    expect(taskRow(cloud.d1).raw_object_key).toBeNull();
  });

  it("重复结果幂等：persist 被执行两次（isolate 崩溃后重放）→ 同一个 key、只有一份 raw、不建第二个 Workflow", async () => {
    const { cloud, engine, run } = await setup();
    let crashed = false;
    engine.after.set(persistStepName(1), () => {
      if (crashed) return;
      crashed = true;
      throw new Error("isolate crashed after the R2 write, before the checkpoint");
    });

    await run();

    expect(engine.attempts[persistStepName(1)]).toBe(2);
    expect(cloud.r2.putLog.filter(key => key === RAW_KEY)).toHaveLength(2); // 同一 key 的幂等覆盖
    expect(rawObjects(cloud)).toEqual([RAW_KEY]);
    expect(taskRow(cloud.d1).raw_object_key).toBe(RAW_KEY);
    expect(cloud.workflow.created).toHaveLength(1);
    expect(cloud.service.posts).toHaveLength(1);
  });

  it("persistRawStep 直接重复调用：同 (task, attempt, provider request) 永远得到同一份 raw", async () => {
    const { cloud } = await setup({ status: "transcribing", provider_request_id: "tsr_0001" });
    await cloud.service.fetch(`${SERVICE_URL}/v1/transcriptions`, {
      method: "POST",
      headers: { "cf-access-client-id": ACCESS_CLIENT_ID, "cf-access-client-secret": ACCESS_CLIENT_SECRET },
      body: JSON.stringify({ request_id: `${TASK}:${ATTEMPT}`, source: { type: "url", url: "https://cdn.example.com/a.mp3" } }),
    });
    cloud.service.steps = ["done"];

    const first = await persistRawStep(cloud.env, paramsFor(), { providerRequestId: "tsr_0001" }, cloud.fetch);
    const second = await persistRawStep(cloud.env, paramsFor(), { providerRequestId: "tsr_0001" }, cloud.fetch);

    expect(first).toEqual({ state: "persisted", rawKey: RAW_KEY });
    expect(second).toEqual(first);
    expect(rawObjects(cloud)).toEqual([RAW_KEY]);
  });

  it("Workflow replay：已完成的 step 不再执行——没有第二份 raw、没有第二次转录 / 精修 / 发布", async () => {
    const { cloud, engine, run } = await setup();
    await run();
    const before = {
      posts: cloud.service.posts.length,
      llm: cloud.externals.llmCalls,
      commits: cloud.externals.github.commits,
      rawPuts: cloud.r2.putLog.filter(key => key.startsWith("raw/")).length,
    };

    const replay = engine.replay();
    const again = await run(replay);

    expect(again.finalPath).toContain("podcasts/transcripts/");
    expect(replay.executed).toEqual([]);
    expect(cloud.service.posts).toHaveLength(before.posts);
    expect(cloud.externals.llmCalls).toBe(before.llm);
    expect(cloud.externals.github.commits).toBe(before.commits);
    expect(cloud.r2.putLog.filter(key => key.startsWith("raw/"))).toHaveLength(before.rawPuts);
    expect(articleCount(cloud)).toBe(1);
  });

  it("isolate 在 publish 提交后、checkpoint 前崩溃：重放不产生第二个内容 commit，也不重新精修 / 转录", async () => {
    const { cloud, engine, run } = await setup();
    engine.crashAfter.add(PUBLISH_STEP);

    await expect(run()).rejects.toBeInstanceOf(IsolateCrash);
    expect(cloud.externals.github.commits).toBe(1);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "success" }); // D1 已提交，只差 checkpoint

    const replay = engine.replay();
    const rawGetsBefore = cloud.r2.getLog.filter(k => k.startsWith("raw/")).length;
    await run(replay);

    expect(replay.executed).toEqual([PUBLISH_STEP]);
    expect(cloud.r2.getLog.filter(key => key === REFINED_KEY)).toHaveLength(2);
    expect(cloud.r2.getLog.filter(k => k.startsWith("raw/")).length).toBe(rawGetsBefore); // publish 不重复读取 R2 raw
    expect(cloud.externals.github.commits).toBe(1);
    expect(cloud.externals.llmCalls).toBe(1);
    expect(cloud.service.posts).toHaveLength(1);
    expect(articleCount(cloud)).toBe(1);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "success" });
  });
});

describe("R2 refined checkpoint", () => {
  it.each([null, "   "])("missing or empty checkpoint (%s) fails without publishing or repeating the model", async (body) => {
    const { cloud, engine, run } = await setup();
    engine.before.set(PUBLISH_STEP, async () => {
      if (body === null) await cloud.r2.delete(REFINED_KEY);
      else await cloud.r2.put(REFINED_KEY, body);
    });
    await expect(run()).rejects.toThrow("[refined_checkpoint_missing]");
    expect(engine.attempts[PUBLISH_STEP]).toBe(1);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "refined_checkpoint_missing" });
    expect(cloud.externals.llmCalls).toBe(1);
    expect(cloud.externals.github.commits).toBe(0);
    expect(rawObjects(cloud)).toEqual([RAW_KEY]);
  });

  it("transient R2 read failure retries publication using the same checkpoint", async () => {
    const { cloud, engine, run } = await setup();
    const get = cloud.r2.get.bind(cloud.r2);
    let failed = false;
    vi.spyOn(cloud.r2, "get").mockImplementation(async (key) => {
      if (key === REFINED_KEY && !failed) {
        failed = true;
        throw new Error("R2 temporarily unavailable");
      }
      return get(key);
    });
    await run();
    expect(engine.attempts[PUBLISH_STEP]).toBe(2);
    expect(cloud.externals.llmCalls).toBe(1);
    expect(cloud.r2.putLog.filter(key => key === REFINED_KEY)).toHaveLength(1);
    expect(taskRow(cloud.d1).status).toBe("success");
  });

  it("failed checkpoint write cannot complete refinement or start publication", async () => {
    const { cloud, engine, run } = await setup();
    const put = cloud.r2.put.bind(cloud.r2);
    vi.spyOn(cloud.r2, "put").mockImplementation(async (key, value, options) => {
      if (key === REFINED_KEY) throw new Error("R2 write unavailable");
      return put(key, value, options);
    });
    await expect(run()).rejects.toThrow("R2 write unavailable");
    expect(engine.executed).not.toContain(PUBLISH_STEP);
    expect(cloud.externals.github.commits).toBe(0);
    expect(cloud.r2.keys("refined/")).toEqual([]);
  });
});

describe("取消：Cloudflare 是唯一权威", () => {
  it("转录期间取消：Workflow 被终止、D1 = cancelled、尽力通知服务取消；此后不再写 raw / 不精修", async () => {
    const { cloud, engine, run } = await setup();
    engine.before.set(pollStepName(1, 2), async () => {
      const response = await cancelOrDeleteTask(TASK, cloud.env, ctxStub);
      expect(response.status).toBe(200);
    });

    await expect(run()).rejects.toThrow("[cancelled]");
    await ctxStub.settle();

    expect(taskRow(cloud.d1)).toMatchObject({ status: "cancelled", message: "任务已取消" });
    expect(cloud.workflow.instances.get(INSTANCE)?.terminated).toBe(true);
    expect(cloud.service.deletes.map(entry => entry.path)).toEqual(["/v1/transcriptions/tsr_0001"]);
    expect(rawObjects(cloud)).toEqual([]);
    expect(cloud.externals.llmCalls).toBe(0);
  });

  it("服务对取消无响应（离线）也不影响 Cloudflare 任务的最终状态", async () => {
    const { cloud, engine, run } = await setup();
    engine.before.set(pollStepName(1, 2), async () => {
      cloud.service.offline = true;
      await cancelOrDeleteTask(TASK, cloud.env, ctxStub);
      await ctxStub.settle();
    });

    await expect(run()).rejects.toThrow("[cancelled]");

    expect(taskRow(cloud.d1).status).toBe("cancelled");
  });

  it("取消 vs 结果晚到（取消先赢）：persist 的 CAS 失败 → 不留 raw、不精修", async () => {
    const { cloud, engine, run } = await setup();
    engine.before.set(persistStepName(1), () => {
      cloud.d1.raw.prepare("UPDATE tasks SET cancel_requested = 1 WHERE id = ?").run(TASK);
    });

    await expect(run()).rejects.toThrow("[cancelled]");

    expect(rawObjects(cloud)).toEqual([]);
    expect(taskRow(cloud.d1).status).toBe("cancelled");
    expect(cloud.externals.llmCalls).toBe(0);
  });

  it("取消 vs 结果晚到（写库落地后才取消）：取消仍然生效，精修不启动", async () => {
    const { cloud, engine, run } = await setup();
    engine.before.set(CLAIM_STEP, async () => {
      await cancelOrDeleteTask(TASK, cloud.env, ctxStub);
    });

    await expect(run()).rejects.toThrow("[cancelled]");

    expect(taskRow(cloud.d1).status).toBe("cancelled");
    expect(cloud.externals.llmCalls).toBe(0);
    expect(cloud.externals.github.commits).toBe(0);
  });

  it("persist 期间被取消：刚写入的 raw 被清理（不留孤儿）", async () => {
    const { cloud, engine, run } = await setup();
    engine.after.set(persistStepName(1), () => undefined);
    // 在 R2.put 之后、D1 CAS 之前取消
    const originalPut = cloud.r2.put.bind(cloud.r2);
    cloud.r2.put = (async (key: string, value: never, options: never) => {
      const result = await originalPut(key, value, options);
      if (key.startsWith("raw/")) cloud.d1.raw.prepare("UPDATE tasks SET cancel_requested = 1 WHERE id = ?").run(TASK);
      return result;
    }) as typeof cloud.r2.put;

    await expect(run()).rejects.toThrow("[cancelled]");

    expect(rawObjects(cloud)).toEqual([]);
    expect(cloud.r2.deleteLog).toContain(RAW_KEY);
  });
});

describe("raw 一旦落库，昂贵步骤不重复", () => {
  it("R2 已有 raw：resolve-raw 直接采纳，完全不联系转录服务", async () => {
    const { cloud, engine, run } = await setup();
    await cloud.r2.put(RAW_KEY, RAW_TEXT);

    await run();

    expect(cloud.service.log).toEqual([]);
    expect(engine.executed).not.toContain("start-transcription");
    expect(engine.executed.some(name => name.startsWith("submit-transcription"))).toBe(false);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "success", raw_object_key: RAW_KEY });
    expect(cloud.externals.llmCalls).toBe(1);
  });

  it("raw 已落库后转录服务整体下线：精修 → 门禁 → 成稿照常完成", async () => {
    const { cloud, engine, run } = await setup();
    // 转录完成、raw 落库之后，服务永久离线；后续任何联系都会抛错。
    engine.after.set(persistStepName(1), () => void (cloud.service.offline = true));

    await run();

    expect(taskRow(cloud.d1).status).toBe("success");
    expect(cloud.externals.llmCalls).toBe(1);
    expect(cloud.externals.github.commits).toBe(1);
  });

  it("精修（LLM）重试不重新转录：转录阶段的 step 各只执行一次", async () => {
    const { cloud, engine, run } = await setup();
    cloud.externals.llmFailures = [500, 500];

    await run();

    expect(engine.attempts[REFINE_STEP]).toBe(3);
    expect(cloud.externals.llmCalls).toBe(3);
    expect(cloud.service.posts).toHaveLength(1);
    expect(submitSteps(engine)).toHaveLength(1);
    expect(engine.attempts[persistStepName(1)]).toBe(1);
    expect(taskRow(cloud.d1).status).toBe("success");
  });

  it("publish（GitHub）重试不重新精修、不重新转录", async () => {
    const { cloud, engine, run } = await setup();
    cloud.externals.githubFailures = [502];

    await run();

    expect(engine.attempts[PUBLISH_STEP]).toBe(2);
    expect(cloud.externals.llmCalls).toBe(1);
    expect(cloud.service.posts).toHaveLength(1);
    expect(cloud.externals.github.commits).toBe(1);
    expect(taskRow(cloud.d1).status).toBe("success");
  });

  it("publish（GitHub）重试全耗尽：error 穿过 step 边界归因为 final_persist_failed，raw 保留，昂贵步骤各仅一次", async () => {
    const { cloud, engine, run } = await setup();
    // 注入持续失败（502），耗尽 publishStep 的所有重试次数
    cloud.externals.githubFailures = [502, 502, 502, 502, 502];

    await expect(run()).rejects.toThrow("[final_persist_failed]");

    expect(engine.attempts[PUBLISH_STEP]).toBe(4); // 1 初始执行 + 3 次 retry
    // 昂贵步骤不重复调用
    expect(cloud.service.posts).toHaveLength(1);
    expect(cloud.externals.llmCalls).toBe(1);
    expect(cloud.externals.github.commits).toBe(0);
    // R2 raw 保留用于后续重试
    expect(rawObjects(cloud)).toEqual([RAW_KEY]);
    // D1 正确归因为 final_persist_failed 而非 refine_api_failed
    expect(taskRow(cloud.d1)).toMatchObject({
      status: "error",
      error_code: "final_persist_failed",
      message: "成稿写入失败，请重试",
      raw_object_key: RAW_KEY,
    });
  });

  it("任务级重试（精修失败后点重试）：新 attempt 的 Workflow 采纳既有 raw，不再联系转录服务", async () => {
    const { cloud } = await setup({ status: "error", error_code: "refine_quality_gate", raw_object_key: RAW_KEY });
    await cloud.r2.put(RAW_KEY, RAW_TEXT);
    cloud.workflow.instances.clear();
    cloud.workflow.created.length = 0;

    const response = await retryTask(TASK, cloud.env, ctxStub);
    expect(response.status).toBe(202);
    const rotated = taskRow(cloud.d1);
    expect(rotated).toMatchObject({ status: "queued", raw_object_key: RAW_KEY, provider_request_id: null, error_code: null });
    expect(rotated.current_attempt_id).not.toBe(ATTEMPT);
    expect(cloud.workflow.created).toHaveLength(1);

    const attempt = rotated.current_attempt_id as string;
    const engine = new DurableStepEngine();
    const workflowId = processingWorkflowId(TASK, attempt);
    await runProcessingPipeline(cloud.env, paramsFor(TASK, attempt), workflowId, engine, { fetchFn: cloud.fetch, poll: FAST_POLL });

    expect(cloud.service.log).toEqual([]);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "success" });
  });
});

describe("音频 source：RSS 与自定义上传", () => {
  it("RSS 音频指向私网 / 本机 / 非 http(s) 地址：Cloudflare 预检直接拒绝，不联系转录服务", async () => {
    for (const audio of ["http://127.0.0.1/a.mp3", "http://[::ffff:7f00:1]/a.mp3", "http://169.254.169.254/latest", "file:///etc/passwd", "https://user:pw@cdn.example.com/a.mp3"]) {
      const { cloud, run } = await setup({ audio_url: audio }, FAST_POLL);
      await expect(run()).rejects.toThrow("[source_not_allowed]");
      expect(cloud.service.log).toEqual([]);
      expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "source_not_allowed" });
    }
  });

  it("自定义上传：转录服务拿到指向确切 R2 对象的 presigned GET（受 200 MiB 上限约束）；raw 落库后原音频被清理", async () => {
    const { cloud, run } = await setup({ source_type: "upload", audio_url: "r2://uploads/up-1/talk.mp3", episode_id: null });
    await cloud.r2.put("uploads/up-1/talk.mp3", new Uint8Array([1, 2, 3, 4]));

    await run();

    const { source } = cloud.service.posts[0].body;
    expect(source.type).toBe("url");
    expect(source.max_bytes).toBe(MAX_UPLOAD_BYTES);
    const { origin, key, params } = presignedParts(source.url);
    expect(origin).toBe(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(key).toBe(`/${R2_BUCKET}/uploads/up-1/talk.mp3`);
    expect(params.get("X-Amz-Expires")).toBe(String(PRESIGNED_SOURCE_TTL_SECONDS));
    // 音频不再经过 Worker 中转：转录服务只拿到 R2 的地址
    expect(source.url).not.toContain("/api/source/uploads/");
    expect(source.url).not.toContain("/api/control/");
    // 转录服务没有任何 Cloudflare / R2 凭据
    expect(source.url).not.toContain(R2_SECRET_ACCESS_KEY);
    expect(source.url).not.toContain("svc-token");
    expect(cloud.r2.keys("uploads/")).toEqual([]);
    expect(taskRow(cloud.d1).status).toBe("success");
  });

  it("presigned source 在文件被清理前一直指向真实对象；同一 submission 内 URL 完全不变", async () => {
    const { cloud, engine, run } = await setup({ source_type: "upload", audio_url: "r2://uploads/up-1/talk.mp3", episode_id: null });
    await cloud.r2.put("uploads/up-1/talk.mp3", new Uint8Array([9, 8, 7]));
    const seen: string[] = [];
    engine.after.set(submitStepName(1), () => {
      seen.push(cloud.service.posts[0].body.source.url);
      // 对象在 raw 落库前仍在 R2 里（签名仍然有效）
      expect(cloud.r2.keys("uploads/")).toEqual(["uploads/up-1/talk.mp3"]);
    });

    await run();

    expect(seen).toHaveLength(1);
    expect(presignedParts(seen[0]).key).toBe(`/${R2_BUCKET}/uploads/up-1/talk.mp3`);
  });

  it("上传音频已过期 / 不存在：upload_expired，不联系转录服务", async () => {
    const { cloud, run } = await setup({ source_type: "upload", audio_url: "r2://uploads/gone/talk.mp3", episode_id: null });

    await expect(run()).rejects.toThrow("[upload_expired]");

    expect(cloud.service.log).toEqual([]);
    expect(taskRow(cloud.d1).error_code).toBe("upload_expired");
  });

  it("上传对象超过 200 MiB 硬上限：在签名之前拒绝（source_too_large），不联系转录服务", async () => {
    const { cloud, run } = await setup({ source_type: "upload", audio_url: "r2://uploads/big/talk.mp3", episode_id: null });
    cloud.r2.putSized("uploads/big/talk.mp3", MAX_UPLOAD_BYTES + 1);

    await expect(run()).rejects.toThrow("[source_too_large]");

    expect(cloud.service.log).toEqual([]);
  });

  it("Cloudflare 缺 R2 签发凭据：自定义上传任务以可行动的原因失败，且不联系转录服务", async () => {
    const { cloud, run } = await setup({ source_type: "upload", audio_url: "r2://uploads/up-1/talk.mp3", episode_id: null });
    cloud.r2.putSized("uploads/up-1/talk.mp3", 4_096);
    (cloud.env as unknown as Record<string, string>).R2_SECRET_ACCESS_KEY = "";

    await expect(run()).rejects.toThrow("[r2_credentials_unconfigured]");

    expect(cloud.service.log).toEqual([]);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "r2_credentials_unconfigured" });
  });

  it("坏 raw（转录异常过短）：不落 R2、不删除上传的原音频（Retry 需要它重新转录）", async () => {
    const { cloud, run } = await setup({ source_type: "upload", audio_url: "r2://uploads/up-1/talk.mp3", episode_id: null });
    await cloud.r2.put("uploads/up-1/talk.mp3", new Uint8Array([1, 2, 3]));
    cloud.service.resultText = "占位文本，太短了。";

    await expect(run()).rejects.toThrow("[transcription_invalid]");

    expect(rawObjects(cloud)).toEqual([]);
    expect(cloud.r2.keys("uploads/")).toEqual(["uploads/up-1/talk.mp3"]);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "transcription_invalid" });
  });
});

describe("引擎边界：错误穿过 step 后只剩 name / message（自定义属性全部丢失）", () => {
  it("nonRetryable() 产出的错误按真实引擎规则被识别为不可重试（name 保持 NonRetryableError，不被 code 覆盖）", () => {
    const error = nonRetryable("transcription_service_auth", "bad token");
    expect(error.name).toBe("NonRetryableError");
    expect(isEngineNonRetryable(error)).toBe(true);
    expect(error.message).toBe("[transcription_service_auth] bad token");
  });

  it("回归：把 code 塞进 NonRetryableError 的 name（旧写法）不会被引擎识别——正是它导致「不可重试错误被一路重试」", async () => {
    const { NonRetryableError } = await import("cloudflare:workflows");
    expect(isEngineNonRetryable(new NonRetryableError("x", "some_code"))).toBe(false);
    expect(isEngineNonRetryable(new NonRetryableError("x"))).toBe(true);
  });

  it("回归：含数字的 code（如 r2_credentials_unconfigured）也能从消息里归因，不静默退化成 transcription_failed", () => {
    const crossed = new Error(`Step threw a NonRetryableError with message "[r2_credentials_unconfigured] presigning requires R2_ACCOUNT_ID"`);
    expect(classifyFailure(crossed, "transcription")).toMatchObject({
      code: "r2_credentials_unconfigured",
      message: expect.stringContaining("R2_ACCOUNT_ID"),
    });
  });

  it.each([true, false])("兼容性开关 workflows_preserve_non_retryable_error_message=%s：不可重试错误的 code 仍能归因，且只执行一次", async preserve => {
    const { cloud, engine, run } = await setup();
    engine.preserveNonRetryableMessage = preserve;
    cloud.env.CF_ACCESS_CLIENT_SECRET = "wrong";

    const failure = await run().then(
      () => null,
      error => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { code?: string }).code).toBeUndefined(); // 属性确实丢了
    expect(engine.attempts[submitStepName(1)]).toBe(1); // 没有被重试
    expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "transcription_service_auth" });
  });

  it("重试耗尽的错误同样只剩消息：仍能归因为 transcription_service_unavailable", async () => {
    const { cloud, run } = await setup();
    cloud.service.offline = true;

    const failure = await run().then(
      () => null,
      error => error as Error,
    );

    expect((failure as Error & { code?: string }).code).toBeUndefined();
    expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "transcription_service_unavailable" });
  });
});

describe("workflowError：领域错误翻译成 step 错误的唯一入口", () => {
  const ctx = { attempt: 1, step: { name: "s", count: 1 } };

  it("可重试：普通 Error，消息带 [code]，Retry-After 交给 durable retry 延迟", () => {
    const error = workflowError("transcription_service_unavailable", "HTTP 503", { retryable: true, retryAfterSeconds: 42 });
    expect(error.name).toBe("Error");
    expect(error.message).toBe("[transcription_service_unavailable] HTTP 503");
    expect(errorCodeOf({ message: error.message })).toBe("transcription_service_unavailable");
    expect(exponentialRetryDelay({ ctx, error })).toBe("42 seconds");
  });

  it("不可重试：NonRetryableError（引擎按 name 识别），code 同样可归因", () => {
    const error = workflowError("refine_provider_auth", "HTTP 401", { retryable: false });
    expect(error.name).toBe("NonRetryableError");
    expect(classifyFailure({ message: error.message }).code).toBe("refine_provider_auth");
  });
});
