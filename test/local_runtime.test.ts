/**
 * 本地运行时（Docker / Node.js）完整语义与契约测试。
 * 覆盖：
 *   - SQLite 迁移执行器与 D1 等价语句语义；
 *   - 本地卷对象存储（CRUD、分片上传、HMAC 签名、生命周期清理）；
 *   - 进程内工作流执行器（断点持久化、重放不重复调用昂贵步骤、崩溃重启续跑、NonRetryableError）；
 *   - Node HTTP 服务（健康检查、Basic Auth 控制面拦截、公共面放行、签名音频下载）。
 */
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyLocalMigrations,
  createLocalAssetFetcher,
  createLocalObjectStore,
  createLocalWorkflowEngine,
  createNodeEnv,
  createSqliteDatabase,
  parseDuration,
  startServer,
  verifyStorageSignature,
  cleanExpiredObjects,
} from "../src/platform/node";
import { NonRetryableError } from "../src/platform/types";
import { runProcessingPipeline } from "../src/workflows/pipeline";
import { processingWorkflowId } from "../src/workflows/processing";
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

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
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
      port: 0, // 动态可用端口
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

    // 3. 控制面未提供凭据 -> 401 Unauthorized
    const controlRes = await fetch(`${base}/manage`);
    expect(controlRes.status).toBe(401);
    expect(controlRes.headers.get("www-authenticate")).toContain("Basic");

    const controlApiRes = await fetch(`${base}/api/control/tasks`);
    expect(controlApiRes.status).toBe(401);

    // 4. 控制面携带正确 Basic Auth 凭据 -> 200 OK
    const authHeader = `Basic ${Buffer.from("admin:secret-password-123").toString("base64")}`;
    const authedManage = await fetch(`${base}/manage`, { headers: { authorization: authHeader } });
    expect(authedManage.status).toBe(200);

    const authedApi = await fetch(`${base}/api/control/tasks`, { headers: { authorization: authHeader } });
    expect(authedApi.status).toBe(200);

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
  });
});
