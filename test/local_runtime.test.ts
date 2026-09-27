/**
 * 本地运行时（Docker / Node.js）完整语义与契约测试。
 * 覆盖：
 *   - SQLite 迁移执行器与 D1 等价语句语义；
 *   - 本地卷对象存储（CRUD、分片上传、HMAC 签名、生命周期清理）；
 *   - 进程内工作流执行器（断点持久化、重放不重复调用昂贵步骤、崩溃重启续跑、NonRetryableError）；
 *   - Node HTTP 服务（健康检查、Basic Auth 控制面拦截、公共面放行、签名音频下载）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLocalMigrations,
  createLocalAssetFetcher,
  createLocalManuscriptStore,
  createLocalObjectStore,
  createLocalWorkflowEngine,
  createNodeEnv,
  createSqliteDatabase,
  parseDuration,
  startServer,
  verifyStorageSignature,
  cleanExpiredObjects,
  resolveOrGenerateSigningSecret,
  LocalWorkflowStepRunner,
} from "../src/platform/node";
import { NonRetryableError } from "../src/platform/types";
import { runProcessingPipeline } from "../src/workflows/pipeline";
import { processingWorkflowId } from "../src/workflows/processing";
import { publicArticleContent } from "../src/public";
import {
  ATTEMPT,
  FAST_POLL,
  RAW_TEXT,
  REFINED_TEXT,
  TASK,
  insertTask,
  makeCloud,
  paramsFor,
  taskRow,
} from "./helpers/cloud";

const TEST_DIR = resolve(process.cwd(), "data/test-local-runtime");
const realFetch = globalThis.fetch;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("本地 SQLite 适配器与迁移执行器", () => {
  it("对全新数据库执行全部迁移，并确保外键约束与工作流断点表就绪", async () => {
    const raw = new DatabaseSync(":memory:");
    const migrationsDir = resolve(process.cwd(), "migrations");
    const applied = applyLocalMigrations(raw, migrationsDir);

    expect(applied.length).toBeGreaterThan(15);
    // 迁移记录表记录了执行过的迁移
    const recorded = raw.prepare("SELECT COUNT(*) AS count FROM d1_migrations").get() as { count: number };
    expect(recorded.count).toBe(applied.length);

    // 再次执行是幂等的
    const secondPass = applyLocalMigrations(raw, migrationsDir);
    expect(secondPass).toEqual([]);

    // 工作流表已就绪
    const instancesTable = raw.prepare("SELECT 1 FROM _workflow_instances LIMIT 1");
    expect(instancesTable).toBeDefined();
    const checkpointsTable = raw.prepare("SELECT 1 FROM _workflow_checkpoints LIMIT 1");
    expect(checkpointsTable).toBeDefined();

    // 数据库适配器语句执行
    const db = createSqliteDatabase(raw);
    const stmt = db.prepare("INSERT INTO subscriptions (name, rss_url) VALUES (?, ?)");
    const res = stmt.bind("测试播客", "https://example.com/feed.xml").run();
    await expect(res).resolves.toMatchObject({ success: true });

    const query = db.prepare("SELECT name, rss_url FROM subscriptions WHERE name = ?");
    await expect(query.bind("测试播客").first("name")).resolves.toBe("测试播客");
    await expect(query.bind("测试播客").all()).resolves.toMatchObject({
      results: [{ name: "测试播客", rss_url: "https://example.com/feed.xml" }],
    });
  });

  it("batch 事务执行：遇到错误时完全回滚", async () => {
    const raw = new DatabaseSync(":memory:");
    applyLocalMigrations(raw, resolve(process.cwd(), "migrations"));
    const db = createSqliteDatabase(raw);

    const s1 = db.prepare("INSERT INTO subscriptions (name, rss_url) VALUES ('A', 'https://a.com')");
    // 重复插入 A 触发唯一键冲突
    const s2 = db.prepare("INSERT INTO subscriptions (name, rss_url) VALUES ('A', 'https://b.com')");

    await expect(db.batch([s1, s2])).rejects.toThrow();

    const count = await db.prepare("SELECT COUNT(*) AS n FROM subscriptions").first<{ n: number }>("n");
    expect(count).toBe(0);
  });
});

describe("本地卷对象存储（ObjectStore）", () => {
  it("CRUD、元数据查询与目录遍历", async () => {
    const storeDir = resolve(TEST_DIR, "storage-crud");
    const store = createLocalObjectStore({ rootDir: storeDir });

    // 1. put 字符串
    const putRes = await store.put("raw/task-1/att-1.txt", "这是一段转录文本");
    expect(putRes.key).toBe("raw/task-1/att-1.txt");
    expect(putRes.size).toBeGreaterThan(0);

    // 2. get 文本
    const getRes = await store.get("raw/task-1/att-1.txt");
    expect(getRes).not.toBeNull();
    expect(await getRes!.text()).toBe("这是一段转录文本");

    // 3. head
    const headRes = await store.head("raw/task-1/att-1.txt");
    expect(headRes?.size).toBe(putRes.size);
    expect(headRes?.httpEtag).toBeDefined();

    // 4. list
    await store.put("raw/task-2/att-1.txt", "第二条");
    await store.put("uploads/audio.mp3", "音频占位");
    const listRaw = await store.list({ prefix: "raw/" });
    expect(listRaw.objects.map(o => o.key)).toEqual(["raw/task-1/att-1.txt", "raw/task-2/att-1.txt"]);

    // 5. delete
    await store.delete("raw/task-1/att-1.txt");
    expect(await store.get("raw/task-1/att-1.txt")).toBeNull();
    expect(await store.head("raw/task-1/att-1.txt")).toBeNull();
  });

  it("分片上传（Multipart Upload）：分块写入并完整拼接", async () => {
    const storeDir = resolve(TEST_DIR, "storage-multipart");
    const store = createLocalObjectStore({ rootDir: storeDir });

    const mp = await store.createMultipartUpload!("uploads/large.mp3");
    const p1 = await mp.uploadPart(1, new TextEncoder().encode("Hello, "));
    const p2 = await mp.uploadPart(2, new TextEncoder().encode("World!"));

    expect(p1.partNumber).toBe(1);
    expect(p2.partNumber).toBe(2);

    const completed = await mp.complete([p2, p1]); // 乱序传入应自动排序
    expect(completed.key).toBe("uploads/large.mp3");

    const obj = await store.get("uploads/large.mp3");
    expect(await obj?.text()).toBe("Hello, World!");
  });

  it("临时 HMAC 签名下载地址生成与防篡改验证", async () => {
    const storeDir = resolve(TEST_DIR, "storage-presign");
    const secret = "test-secret-key-123";
    const store = createLocalObjectStore({ rootDir: storeDir, baseUrl: "http://127.0.0.1:3000", signingSecret: secret });

    const nowMs = 1700000000000;
    const urlStr = await store.createPresignedUrl!("uploads/audio.mp3", { nowMs, expiresInSeconds: 3600 });
    const url = new URL(urlStr);

    expect(url.origin).toBe("http://127.0.0.1:3000");
    expect(url.pathname).toBe("/storage/download");
    expect(url.searchParams.get("key")).toBe("uploads/audio.mp3");

    const expires = Number(url.searchParams.get("expires"));
    const sig = url.searchParams.get("sig")!;

    // 正常验证通过
    expect(verifyStorageSignature("uploads/audio.mp3", expires, sig, secret, nowMs)).toBe(true);

    // 篡改 key -> 失败
    expect(verifyStorageSignature("uploads/other.mp3", expires, sig, secret, nowMs)).toBe(false);

    // 篡改 expires -> 失败
    expect(verifyStorageSignature("uploads/audio.mp3", expires + 10, sig, secret, nowMs)).toBe(false);

    // 过期 -> 失败
    const expiredMs = (expires + 10) * 1000;
    expect(verifyStorageSignature("uploads/audio.mp3", expires, sig, secret, expiredMs)).toBe(false);

    // 错误 secret -> 失败
    expect(verifyStorageSignature("uploads/audio.mp3", expires, sig, "wrong-secret", nowMs)).toBe(false);
  });

  it("定时清理超期对象：uploads 1天，raw 7天，未过期保留", async () => {
    const storeDir = resolve(TEST_DIR, "storage-retention");
    const store = createLocalObjectStore({ rootDir: storeDir });

    await store.put("uploads/old.mp3", "old upload");
    await store.put("uploads/new.mp3", "new upload");
    await store.put("raw/old.txt", "old raw");
    await store.put("raw/new.txt", "new raw");

    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * 86_400_000);
    const eightDaysAgo = new Date(now - 8 * 86_400_000);

    // 人工改写 mtime 模拟超期
    utimesSync(resolve(storeDir, "uploads/old.mp3"), twoDaysAgo, twoDaysAgo);
    utimesSync(resolve(storeDir, "raw/old.txt"), eightDaysAgo, eightDaysAgo);

    const result = await cleanExpiredObjects(storeDir, now);
    expect(result.deletedFiles).toBe(2);

    expect(await store.get("uploads/old.mp3")).toBeNull();
    expect(await store.get("raw/old.txt")).toBeNull();
    expect(await store.get("uploads/new.mp3")).not.toBeNull();
    expect(await store.get("raw/new.txt")).not.toBeNull();
  });

  it("分片上传安全：严格校验 uploadId 格式，防止目录遍历与任意文件删除/写入", async () => {
    const storeDir = resolve(TEST_DIR, "storage-multipart-security");
    const store = createLocalObjectStore({ rootDir: storeDir });

    // 1. 尝试使用 ../.. 路径穿越 uploadId 恢复
    expect(() => store.resumeMultipartUpload!("uploads/malicious.mp3", "../../etc")).toThrow(/Invalid uploadId/);
    expect(() => store.resumeMultipartUpload!("uploads/malicious.mp3", "random-id")).toThrow(/Invalid uploadId/);

    // 2. 正常格式 localmp-12345-abc123
    const validId = "localmp-1700000000-abc123";
    const adapter = store.resumeMultipartUpload!("uploads/audio.mp3", validId);

    // 3. 非法 partNumber
    await expect(adapter.uploadPart(0, new Uint8Array([1]))).rejects.toThrow(/Invalid partNumber/);
    await expect(adapter.uploadPart(-1, new Uint8Array([1]))).rejects.toThrow(/Invalid partNumber/);
    await expect(adapter.uploadPart(10001, new Uint8Array([1]))).rejects.toThrow(/Invalid partNumber/);

    // 4. abort 只能删除对应的 partDir，无法逃逸
    await adapter.uploadPart(1, new Uint8Array([1, 2, 3]));
    await adapter.abort();
    expect(existsSync(resolve(storeDir, ".multiparts", validId))).toBe(false);
  });

  it("签名密钥安全：未提供密钥时自动生成随机密钥并持久化至 0600 文件，绝不使用固定默认值", () => {
    const dataDir = resolve(TEST_DIR, "key-gen-data");
    mkdirSync(dataDir, { recursive: true });

    // 1. 未配置任何 secret
    const secret1 = resolveOrGenerateSigningSecret({ dataDir });
    expect(secret1).toBeDefined();
    expect(secret1.length).toBe(64); // 32 字节 hex
    expect(secret1).not.toBe("read-podcast-local-storage-secret");

    // 2. 检查文件权限
    const keyFile = resolve(dataDir, "signing.key");
    expect(existsSync(keyFile)).toBe(true);
    const stat = statSync(keyFile);
    // mode 掩码后八进制 0600
    expect(stat.mode & 0o777).toBe(0o600);

    // 3. 第二次读取：复用已持久化的密钥，绝不每次变动导致旧签名失效
    const secret2 = resolveOrGenerateSigningSecret({ dataDir });
    expect(secret2).toBe(secret1);

    // 4. 显式提供 secret 时优先使用显式配置
    const secretExplicit = resolveOrGenerateSigningSecret({ explicitSecret: "my-custom-key-999", dataDir });
    expect(secretExplicit).toBe("my-custom-key-999");
  });
});

describe("本地工作流执行器（TaskWorkflowEngine & WorkflowStepLike）", () => {
  it("断点持久化与重放：昂贵步骤（转录、LLM、GitHub）绝不重复执行", async () => {
    const cloud = makeCloud();
    const raw = new DatabaseSync(":memory:");
    applyLocalMigrations(raw, resolve(process.cwd(), "migrations"));

    // 将 cloud 的 D1 替换为 real SQLite
    cloud.d1.raw.close();
    cloud.d1.raw = raw;

    insertTask(cloud.d1, { status: "queued" });

    let llmExecutionCount = 0;
    let transcriptionCount = 0;

    const engine = createLocalWorkflowEngine({
      db: raw,
      handler: async (params, instanceId, step) => {
        // 使用与真实管线相同的 step 接口
        const rawKey = await step.do("transcribe", { retries: { limit: 1 } }, async () => {
          transcriptionCount += 1;
          await cloud.r2.put("raw/t1.txt", RAW_TEXT);
          return "raw/t1.txt";
        });

        const refined = await step.do("refine", { retries: { limit: 1 } }, async () => {
          llmExecutionCount += 1;
          return REFINED_TEXT;
        });

        return { rawKey, refined };
      },
    });

    const instanceId = processingWorkflowId(TASK, ATTEMPT);
    await engine.create({ id: instanceId, params: paramsFor() });

    const status1 = await engine.waitForInstance(instanceId);
    expect(status1).toBe("complete");
    expect(transcriptionCount).toBe(1);
    expect(llmExecutionCount).toBe(1);

    // 重新运行（重放）：断点已全部持久化，回调次数必须保持为 1！
    const replayStep = new (await import("../src/platform/node/workflow")).LocalWorkflowStepRunner(raw, instanceId, () => false);
    const rerunRaw = await replayStep.do("transcribe", { retries: { limit: 1 } }, async () => {
      transcriptionCount += 1;
      return "wrong";
    });
    const rerunRefined = await replayStep.do("refine", { retries: { limit: 1 } }, async () => {
      llmExecutionCount += 1;
      return "wrong";
    });

    expect(rerunRaw).toBe("raw/t1.txt");
    expect(rerunRefined).toBe(REFINED_TEXT);
    // 没有发生二次调用！
    expect(transcriptionCount).toBe(1);
    expect(llmExecutionCount).toBe(1);
  });

  it("进程重启模拟：从未完成的断点处继续执行，已完成的断点不重新运行", async () => {
    const raw = new DatabaseSync(":memory:");
    applyLocalMigrations(raw, resolve(process.cwd(), "migrations"));

    let step1Called = 0;
    let step2Called = 0;

    const instanceId = "process-restart-test";
    // 模拟之前进程崩溃前已经写入了 step1 的 checkpoint
    raw.prepare(`
      INSERT INTO _workflow_instances (id, params, status)
      VALUES (?, ?, 'running')
    `).run(instanceId, JSON.stringify({ test: 123 }));

    raw.prepare(`
      INSERT INTO _workflow_checkpoints (instance_id, step_name, output)
      VALUES (?, 'step1', ?)
    `).run(instanceId, JSON.stringify("step1-saved-output"));

    // 新进程启动：初始化 engine 并 resume
    const engine = createLocalWorkflowEngine({
      db: raw,
      handler: async (_params, instId, step) => {
        const out1 = await step.do("step1", { retries: { limit: 1 } }, async () => {
          step1Called += 1;
          return "new-step1";
        });
        const out2 = await step.do("step2", { retries: { limit: 1 } }, async () => {
          step2Called += 1;
          return `out2-from-${out1}`;
        });
        return { out1, out2 };
      },
    });

    const resumedCount = await engine.resumeRunningWorkflows();
    expect(resumedCount).toBe(1);

    const status = await engine.waitForInstance(instanceId);
    expect(status).toBe("complete");

    // step1 命中旧 checkpoint，没有执行回调；step2 执行了一次
    expect(step1Called).toBe(0);
    expect(step2Called).toBe(1);

    // 数据库中 step2 的 checkpoint 已写入
    const ck2 = raw.prepare("SELECT output FROM _workflow_checkpoints WHERE instance_id = ? AND step_name = 'step2'").get(instanceId) as { output: string };
    expect(JSON.parse(ck2.output)).toBe("out2-from-step1-saved-output");
  });

  it("NonRetryableError 立即终止，不触发重试", async () => {
    const raw = new DatabaseSync(":memory:");
    applyLocalMigrations(raw, resolve(process.cwd(), "migrations"));

    let attempts = 0;
    const engine = createLocalWorkflowEngine({
      db: raw,
      handler: async (_params, instId, step) => {
        await step.do("failing-step", { retries: { limit: 5 } }, async () => {
          attempts += 1;
          throw new NonRetryableError("fatal config missing");
        });
      },
    });

    const instanceId = "non-retry-test";
    await engine.create({ id: instanceId, params: {} });
    const status = await engine.waitForInstance(instanceId);

    expect(status).toBe("errored");
    // 只执行了 1 次，没有重试
    expect(attempts).toBe(1);
  });

  it("Step 超时控制：超过 step.timeout 抛出 TimeoutError", async () => {
    const raw = new DatabaseSync(":memory:");
    applyLocalMigrations(raw, resolve(process.cwd(), "migrations"));

    const runner = new LocalWorkflowStepRunner(raw, "timeout-inst", () => false);
    await expect(
      runner.do("timed-out-step", { timeout: "50ms", retries: { limit: 0 } }, async () => {
        await new Promise(r => setTimeout(r, 200));
        return "done";
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("Step 默认重试：未显式配置 retries.limit 时默认具备 5 次重试能力", async () => {
    const raw = new DatabaseSync(":memory:");
    applyLocalMigrations(raw, resolve(process.cwd(), "migrations"));

    const runner = new LocalWorkflowStepRunner(raw, "default-retry-inst", () => false);
    let attempts = 0;
    const res = await runner.do("flaky-step", { retries: { delay: 1 } }, async ({ attempt }) => {
      attempts = attempt;
      if (attempt < 3) throw new Error("temporary network hitch");
      return "succeeded-at-3";
    });

    expect(res).toBe("succeeded-at-3");
    expect(attempts).toBe(3);
  });

  it("真实 ProcessingPipeline 在 LocalWorkflowStepRunner 上运行：断点持久化到 SQLite，重放不重复调用昂贵步骤", async () => {
    const cloud = makeCloud();
    const raw = new DatabaseSync(":memory:");
    applyLocalMigrations(raw, resolve(process.cwd(), "migrations"));

    // 将 cloud 的 D1 替换为 real SQLite
    cloud.d1.raw.close();
    cloud.d1.raw = raw;
    cloud.env.db = createSqliteDatabase(raw);

    insertTask(cloud.d1, { status: "queued" });
    globalThis.fetch = cloud.fetch;

    const instanceId = processingWorkflowId(TASK, ATTEMPT);
    const localRunner = new LocalWorkflowStepRunner(raw, instanceId, () => false);

    // 第一次运行：完整跑通真实业务管线
    const res1 = await runProcessingPipeline(cloud.env, paramsFor(TASK, ATTEMPT), instanceId, localRunner, {
      fetchFn: cloud.fetch,
      poll: FAST_POLL,
    });

    expect(res1.finalPath).toContain("podcasts/transcripts/");
    expect(taskRow(cloud.d1)).toMatchObject({ status: "success", progress: 100 });
    expect(cloud.service.posts).toHaveLength(1);
    expect(cloud.externals.llmCalls).toBe(1);
    expect(cloud.externals.github.commits).toBe(1);

    // 检查 SQLite 中的 _workflow_checkpoints 表已持久化各个 step
    const checkpoints = raw.prepare("SELECT step_name FROM _workflow_checkpoints WHERE instance_id = ?").all(instanceId) as Array<{ step_name: string }>;
    const stepNames = checkpoints.map(c => c.step_name);
    expect(stepNames).toContain("claim-refinement");
    expect(stepNames.some(s => s.startsWith("submit-transcription-"))).toBe(true);
    expect(stepNames).toContain("refine");
    expect(stepNames).toContain("validate-and-publish");

    // 第二次运行（重放 / 故障恢复）：创建新的 LocalWorkflowStepRunner 实例针对同一个 instanceId
    const replayRunner = new LocalWorkflowStepRunner(raw, instanceId, () => false);
    const res2 = await runProcessingPipeline(cloud.env, paramsFor(TASK, ATTEMPT), instanceId, replayRunner, {
      fetchFn: cloud.fetch,
      poll: FAST_POLL,
    });

    expect(res2.finalPath).toBe(res1.finalPath);
    // 关键断言：重放后转录提交、LLM 精修、GitHub 提交次数完全没有增加！
    expect(cloud.service.posts).toHaveLength(1);
    expect(cloud.externals.llmCalls).toBe(1);
    expect(cloud.externals.github.commits).toBe(1);
  });

  it("Docker Compose 拓扑端到端验证：受信内网转录端点 (C) + 上传音频受控访问与 SSRF 白名单放行 (D)", async () => {
    const raw = new DatabaseSync(":memory:");
    applyLocalMigrations(raw, resolve(process.cwd(), "migrations"));

    const srvDir = resolve(TEST_DIR, "compose-e2e-storage");
    rmSync(srvDir, { recursive: true, force: true });
    mkdirSync(srvDir, { recursive: true });

    const composeEnv = createNodeEnv({
      storageDir: srvDir,
      databasePath: ":memory:",
      baseUrl: "http://web:3000",
      env: {
        APP_ENV: "test",
        TRANSCRIPTION_SERVICE_URL: "http://transcription:28100",
        TRUSTED_INTERNAL_TRANSCRIPTION: "true",
        BASE_URL: "http://web:3000",
        REFINER_API_KEY: "test-refiner-key",
        GITHUB_TOKEN: "test-token",
        GITHUB_OWNER: "test-owner",
        GITHUB_REPO: "test-repo",
      },
    });

    // 模拟用户上传自定义音频至本地存储
    const uploadKey = "uploads/custom-compose/audio.mp3";
    await composeEnv.objectStore.put(uploadKey, "fake-audio-payload-for-compose");

    const composeTask = "compose-task-1";
    const composeAttempt = "compose-attempt-1";
    const instanceId = processingWorkflowId(composeTask, composeAttempt);

    // 插入 custom 上传音频任务
    insertTask({ raw: composeEnv.dbSync } as any, {
      id: composeTask,
      attempt: composeAttempt,
      source_type: "upload",
      audio_url: `r2://${uploadKey}`,
      status: "queued",
    });

    let downloadedAudioFromWeb = "";
    let transcriptionSubmitted = false;
    let currentRequestId = "";

    const composeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : (input as Request).url);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);

      if (url.startsWith("http://transcription:28100")) {
        // C: 验证出站请求无需 CF Access 凭据即被接受
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        expect(headers.get("cf-access-client-id")).toBeNull();
        expect(headers.get("cf-access-client-secret")).toBeNull();

        if (url.includes("/health")) {
          return Response.json({ status: "ok", service: "transcription-service", engine: "faster-whisper" });
        }

        if (url.includes("/v1/transcriptions") && method === "POST") {
          transcriptionSubmitted = true;
          const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
          currentRequestId = body.request_id;
          const audioUrl = body.source?.url;

          // D: 转录服务收到音频 URL (http://web:3000/storage/download?...)
          expect(audioUrl).toContain("http://web:3000/storage/download");

          const parsed = new URL(audioUrl);
          expect(parsed.hostname).toBe("web");

          // 验证签名有效并从本地存储获取
          const key = parsed.searchParams.get("key");
          const expires = Number(parsed.searchParams.get("expires"));
          const sig = parsed.searchParams.get("sig");
          expect(verifyStorageSignature(key!, expires, sig!, composeEnv.signingSecret)).toBe(true);

          const obj = await composeEnv.objectStore.get(key!);
          downloadedAudioFromWeb = await obj!.text();

          return Response.json({
            request_id: currentRequestId,
            provider_request_id: "tsr_compose_001",
            status: "completed",
            progress: { phase: "transcribing", percent: 100 },
            result: { language: "zh", duration: 120 },
          }, { status: 200 });
        }

        if (url.includes("/v1/transcriptions/tsr_compose_001/result")) {
          return new Response(RAW_TEXT, { status: 200, headers: { "content-type": "text/plain" } });
        }

        if (url.includes("/v1/transcriptions/tsr_compose_001")) {
          return Response.json({
            request_id: currentRequestId,
            provider_request_id: "tsr_compose_001",
            status: "completed",
            progress: { phase: "transcribing", percent: 100 },
            result: { language: "zh", duration: 120 },
          });
        }
      }

      // Fake LLM & GitHub
      if (url.includes("/chat/completions")) {
        return Response.json({ choices: [{ message: { content: REFINED_TEXT }, finish_reason: "stop" }] });
      }
      if (url.includes("api.github.com")) {
        if (url.includes("/contents/")) return new Response(null, { status: 404 });
        if (url.includes("/git/ref/heads/")) return Response.json({ object: { sha: "base-sha" } });
        if (url.includes("/git/commits/")) return Response.json({ tree: { sha: "tree-sha" } });
        if (url.includes("/git/blobs")) return Response.json({ sha: "blob-sha" }, { status: 201 });
        if (url.includes("/git/trees")) return Response.json({ sha: "new-tree-sha" }, { status: 201 });
        if (url.includes("/git/commits") && method === "POST") return Response.json({ sha: "commit-sha" }, { status: 201 });
        if (url.includes("/git/refs/heads/")) return Response.json({ sha: "commit-sha" });
      }

      throw new Error(`Unexpected fetch in compose test: ${url}`);
    };

    globalThis.fetch = composeFetch;

    const runner = new LocalWorkflowStepRunner(composeEnv.dbSync, instanceId, () => false);
    const result = await runProcessingPipeline(composeEnv.env, paramsFor(composeTask, composeAttempt), instanceId, runner, {
      fetchFn: composeFetch,
      poll: FAST_POLL,
    });

    expect(result.finalPath).toContain("podcasts/transcripts/");
    expect(transcriptionSubmitted).toBe(true);
    expect(downloadedAudioFromWeb).toBe("fake-audio-payload-for-compose");

    const row = composeEnv.dbSync.prepare("SELECT status, progress, raw_object_key FROM tasks WHERE id = ?").get(composeTask) as any;
    expect(row.status).toBe("success");
    expect(row.progress).toBe(100);
    expect(row.raw_object_key).toBe(`raw/${composeTask}/${composeAttempt}.txt`);

    composeEnv.close();
    rmSync(srvDir, { recursive: true, force: true });
  });
});

describe("本地 Node HTTP 服务（Server & Basic Auth）", () => {
  let running: Awaited<ReturnType<typeof startServer>> | null = null;

  afterEach(async () => {
    if (running) {
      await running.close();
      running = null;
    }
  });

  it("服务监听指定端口，提供健康检查、Basic Auth 拦截和签名存储流式下载", async () => {
    const srvDir = resolve(TEST_DIR, "srv-data");
    mkdirSync(srvDir, { recursive: true });

    running = await startServer({
      port: 39101, // 独立端口
      host: "127.0.0.1",
      databasePath: ":memory:",
      storageDir: srvDir,
      authUsername: "admin",
      authPassword: "secret-password-123",
      signingSecret: "test-srv-secret",
    });

    const base = `http://${running.host}:${running.port}`;

    // 1. 公共面健康检查直达（无需认证）
    const healthRes = await fetch(`${base}/api/public/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as any;
    expect(healthJson.status).toBe("ok");

    // 2. 公开浏览页面直达（无需认证）
    const indexRes = await fetch(`${base}/`);
    expect(indexRes.status).toBe(200);
    expect(indexRes.headers.get("content-type")).toContain("text/html");
    await indexRes.text();

    // 3. 控制面未提供凭据 -> 401 Unauthorized
    const controlRes = await fetch(`${base}/manage`);
    expect(controlRes.status).toBe(401);
    expect(controlRes.headers.get("www-authenticate")).toContain("Basic");
    await controlRes.text();

    const controlApiRes = await fetch(`${base}/api/control/tasks`);
    expect(controlApiRes.status).toBe(401);
    await controlApiRes.text();

    // 4. 控制面携带正确 Basic Auth 凭据 -> 200 OK
    const authHeader = `Basic ${Buffer.from("admin:secret-password-123").toString("base64")}`;
    const authedManage = await fetch(`${base}/manage`, { headers: { authorization: authHeader } });
    expect(authedManage.status).toBe(200);
    await authedManage.text();

    const authedApi = await fetch(`${base}/api/control/tasks`, { headers: { authorization: authHeader } });
    expect(authedApi.status).toBe(200);
    await authedApi.text();

    // 5. 存储下载签名验证
    await running.runtime.objectStore.put("uploads/audio.mp3", "fake audio bytes for transcription");
    const downloadUrl = await running.runtime.objectStore.createPresignedUrl!("uploads/audio.mp3", { expiresInSeconds: 60 });

    // 用签名 URL 下载 -> 200
    const dlRes = await fetch(downloadUrl);
    expect(dlRes.status).toBe(200);
    expect(await dlRes.text()).toBe("fake audio bytes for transcription");

    // 篡改签名 -> 403
    const badDlRes = await fetch(downloadUrl + "tampered");
    expect(badDlRes.status).toBe(403);
    await badDlRes.text();

    // 6. Range 头部分请求支持（HTTP 206）
    const rangeRes = await fetch(downloadUrl, { headers: { range: "bytes=0-3" } });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("content-range")).toBe("bytes 0-3/34");
    expect(rangeRes.headers.get("content-length")).toBe("4");
    expect(await rangeRes.text()).toBe("fake");

    // end 超过文件长度：截断到最后一个字节，content-length 与实际字节一致
    const overRange = await fetch(downloadUrl, { headers: { range: "bytes=30-999" } });
    expect(overRange.status).toBe(206);
    expect(overRange.headers.get("content-range")).toBe("bytes 30-33/34");
    expect(overRange.headers.get("content-length")).toBe("4");
    expect((await overRange.arrayBuffer()).byteLength).toBe(4);

    // 后缀范围 bytes=-N：最后 N 个字节
    const suffixRange = await fetch(downloadUrl, { headers: { range: "bytes=-4" } });
    expect(suffixRange.status).toBe(206);
    expect(suffixRange.headers.get("content-range")).toBe("bytes 30-33/34");
    expect((await suffixRange.arrayBuffer()).byteLength).toBe(4);

    // 超出范围的 Range -> 416
    const badRange = await fetch(downloadUrl, { headers: { range: "bytes=100-200" } });
    expect(badRange.status).toBe(416);
    await badRange.text();
  });

  it("Basic Auth 安全：支持密码中包含冒号，且采用常量时间比对", async () => {
    const srvDir = resolve(TEST_DIR, "srv-colon-data");
    mkdirSync(srvDir, { recursive: true });

    running = await startServer({
      port: 39102,
      host: "127.0.0.1",
      databasePath: ":memory:",
      storageDir: srvDir,
      authUsername: "admin",
      authPassword: "p:a:s:s:w:o:r:d:with:colons",
      signingSecret: "test-secret",
    });

    const base = `http://${running.host}:${running.port}`;
    const authHeader = `Basic ${Buffer.from("admin:p:a:s:s:w:o:r:d:with:colons").toString("base64")}`;
    const res = await fetch(`${base}/manage`, { headers: { authorization: authHeader, connection: "close" } });
    expect(res.status).toBe(200);
    await res.text();

    const wrongHeader = `Basic ${Buffer.from("admin:p:a:s:s:w:o:r:d:wrong").toString("base64")}`;
    const wrongRes = await fetch(`${base}/manage`, { headers: { authorization: wrongHeader, connection: "close" } });
    expect(wrongRes.status).toBe(401);
    await wrongRes.text();
  });
});

describe("稿件存储装配（ManuscriptStore，#28）", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("配置 manuscriptDir → 本地目录 store:发布落盘且全程零 GitHub API 请求", async () => {
    const manuscriptDir = resolve(TEST_DIR, "e2e-manuscripts");
    const githubCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.github.com")) githubCalls.push(url);
      return realFetch(input, init);
    }) as typeof globalThis.fetch;

    const runtime = createNodeEnv({
      databasePath: ":memory:",
      storageDir: resolve(TEST_DIR, "e2e-storage"),
      manuscriptDir,
      env: { APP_ENV: "test", GITHUB_TOKEN: "t", GITHUB_OWNER: "o", GITHUB_REPO: "r" },
    });

    const markdown = "# 装配端到端\n\n正文。";
    const published = await runtime.env.manuscripts.publish({
      writingFilename: "20260927_测试播客_装配",
      title: "装配",
      markdown,
    });
    expect(published.path).toBe("podcasts/transcripts/20260927_测试播客_装配.md");
    expect(existsSync(resolve(manuscriptDir, published.path))).toBe(true);
    expect(githubCalls).toHaveLength(0);
    runtime.close();
  });

  it("未配置 MANUSCRIPT_PATH 但 GITHUB_* 齐全 → GitHub store:发布请求 api.github.com", async () => {
    const githubCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        githubCalls.push(url);
        if (url.includes("/contents/")) return new Response(null, { status: 404 });
        if (url.includes("/git/ref/heads/")) return Response.json({ object: { sha: "base-sha" } });
        if (url.includes("/git/commits/")) return Response.json({ tree: { sha: "tree-sha" } });
        if (url.includes("/git/blobs")) return Response.json({ sha: "blob-sha" }, { status: 201 });
        if (url.includes("/git/trees")) return Response.json({ sha: "new-tree-sha" }, { status: 201 });
        if (url.includes("/git/refs/heads/")) return Response.json({ sha: "commit-sha" });
        if (url.endsWith("/git/commits")) return Response.json({ sha: "commit-sha" }, { status: 201 });
      }
      return realFetch(input, init);
    }) as typeof globalThis.fetch;

    const runtime = createNodeEnv({
      databasePath: ":memory:",
      storageDir: resolve(TEST_DIR, "e2e-storage-github"),
      env: { APP_ENV: "test", GITHUB_TOKEN: "t", GITHUB_OWNER: "o", GITHUB_REPO: "r" },
    });

    const published = await runtime.env.manuscripts.publish({
      writingFilename: "20260927_测试播客_回落",
      title: "回落",
      markdown: "# GitHub 回落",
    });
    expect(published.version).toBe("commit-sha");
    expect(githubCalls.length).toBeGreaterThan(0);
    runtime.close();
  });

  it("两者皆缺 → 启动警告但不失败,回落 GitHub store(凭据在 publish 时明确报错)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createNodeEnv({
      databasePath: ":memory:",
      storageDir: resolve(TEST_DIR, "e2e-storage-none"),
      env: { APP_ENV: "test" },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("No manuscript store configured"));
    await expect(runtime.env.manuscripts.publish({
      writingFilename: "x", title: "x", markdown: "# x",
    })).rejects.toThrow(/GITHUB_TOKEN is not configured|GITHUB_OWNER/);
    runtime.close();
  });

  it("端到端:本地 store 发布 → articles 行(commit_sha = 内容哈希) → 公开页读发布快照", async () => {
    const runtime = createNodeEnv({
      databasePath: ":memory:",
      storageDir: resolve(TEST_DIR, "e2e-storage-e2e"),
      manuscriptDir: resolve(TEST_DIR, "e2e-manuscripts-e2e"),
      env: { APP_ENV: "test" },
    });

    const markdown = "---\ntitle: 端到端\n---\n\n# 端到端\n\n正文内容。";
    const published = await runtime.env.manuscripts.publish({
      writingFilename: "20260927_测试播客_端到端",
      title: "端到端",
      markdown,
    });

    const taskId = "12345678-1234-1234-1234-123456789abe";
    runtime.dbSync.prepare(
      `INSERT INTO tasks (id, source_type, episode_title, status, progress, message, updated_at)
       VALUES (?, 'upload', '端到端', 'success', 100, '已完成', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(taskId);
    runtime.dbSync.prepare(
      `INSERT INTO articles (task_id, title, podcast_name, content_path, commit_sha, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(taskId, "端到端", "测试播客", published.path, published.version);

    // 覆盖发布新内容,公开页仍按 articles.commit_sha 读旧版本(发布快照语义)
    const url = new URL(`http://localhost/api/public/articles/${taskId}/content`);
    const res = await publicArticleContent(taskId, url, runtime.env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(markdown);

    // 更新 D1 指向新版本 → 公开页读到新内容
    const v2 = await runtime.env.manuscripts.publish({
      writingFilename: "20260927_测试播客_端到端",
      title: "端到端",
      markdown: "# 第二版",
    });
    runtime.dbSync.prepare("UPDATE articles SET content_path = ?, commit_sha = ? WHERE task_id = ?")
      .run(v2.path, v2.version, taskId);
    const res2 = await publicArticleContent(taskId, url, runtime.env);
    expect(res2.status).toBe(200);
    expect(await res2.text()).toBe("# 第二版");

    // 不存在的版本 → 404 content_not_found
    runtime.dbSync.prepare("UPDATE articles SET commit_sha = ? WHERE task_id = ?")
      .run("f".repeat(64), taskId);
    const res3 = await publicArticleContent(taskId, url, runtime.env);
    expect(res3.status).toBe(404);

    runtime.close();
  });

  it("createLocalManuscriptStore 直接导出可用(与 barrel 一致)", () => {
    expect(typeof createLocalManuscriptStore).toBe("function");
  });
});
