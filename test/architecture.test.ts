/**
 * 架构护栏：Cloudflare 拥有整条业务生命周期；转录服务只是外部计算。
 *
 * 这些测试不验证行为细节，而是把「不允许回退」的结构性结论固化下来：
 *   - 没有任何外部节点可以回调 / 对账 / 抢占任务的入口；
 *   - 运行时契约里没有 Mac / worker 专属词汇；
 *   - 转录服务代码不持有任何 Cloudflare 业务概念。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { ATTEMPT, TASK, UPLOAD_ID, makeCloud } from "./helpers/cloud";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf-8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(new URL(dir, ROOT))) {
    if (["node_modules", ".venv", "__pycache__", ".pytest_cache", "data"].includes(name)) continue;
    const path = `${dir}${name}`;
    if (statSync(new URL(path, ROOT)).isDirectory()) walk(`${path}/`, out);
    else out.push(path);
  }
  return out;
}

const call = (cloud: ReturnType<typeof makeCloud>, path: string, method = "GET", extra: RequestInit = {}) =>
  worker.fetch(new Request(`https://app.test${path}`, { method, ...extra }), cloud.env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);

/** 会随部署进入运行时的文件：Env / 配置 / 前端分片 / 迁移。 */
const runtimeFiles = [...walk("src/"), ...walk("public/js/"), "wrangler.jsonc", ".dev.vars.example", "migrations/0015_cloudflare_owned_transcription.sql"];

describe("外部节点没有任何可以驱动任务状态的入口", () => {
  it.each([
    ["GET", "/api/internal/tasks/waiting"],
    ["POST", "/api/internal/tasks/reclaim"],
    ["POST", "/api/internal/tasks/reconcile"],
    ["POST", `/api/internal/tasks/${TASK}/progress`],
    ["PUT", `/api/internal/tasks/${TASK}/raw`],
    ["GET", `/api/internal/tasks/${TASK}/raw`],
    ["POST", `/api/internal/tasks/${TASK}/complete`],
    ["GET", "/api/internal/uploads/up-1/audio"],
  ])("%s %s → 404（旧的 worker 回调 / 对账 / raw handoff 入口已删除）", async (method, path) => {
    const cloud = makeCloud();
    const res = await call(cloud, path, method, method === "GET" ? {} : { headers: { authorization: "Bearer anything", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(404);
  });

  it("旧的 Worker 自建签名源端点已删除，且没有任何替代的音频代理入口", async () => {
    const cloud = makeCloud();
    cloud.r2.putSized(`uploads/${UPLOAD_ID}/a.mp3`, 100);
    for (const method of ["GET", "HEAD", "POST"]) {
      const res = await call(cloud, `/api/source/uploads/${UPLOAD_ID}/audio?exp=9999999999&sig=${"A".repeat(43)}`, method);
      expect(res.status, method).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    }
    // 旧端点的 bearer 令牌同样没有意义
    expect((await call(cloud, `/api/source/uploads/${UPLOAD_ID}/audio`, "GET", { headers: { authorization: "Bearer svc-token" } })).status).toBe(404);
    expect(cloud.service.log).toEqual([]);
  });

  it("Worker 不再中转音频：源码里没有签名 / 代理音频的实现，也没有音频流复制的响应体", () => {
    for (const file of walk("src/")) {
      const text = read(file);
      expect(text, file).not.toMatch(/SOURCE_SIGNING_KEY|PUBLIC_BASE_URL|signUploadSourceUrl|verifyUploadSourceSignature|SOURCE_URL_TTL_SECONDS|getSignedUploadAudio|source\/uploads/);
      // 也不保留任何「先取对象再原样转发」的路径
      expect(text, file).not.toMatch(/RAW_BUCKET\.get\([^)]*\)[\s\S]{0,200}object\.body/);
    }
  });

  it("Cloudflare 是唯一持有 R2 凭据的一侧；转录服务完全看不到它们", () => {
    for (const file of walk("transcription_service/")) {
      if (!/\.(py|yaml|toml|example)$/.test(file)) continue;
      expect(read(file), file).not.toMatch(/R2_ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|cloudflarestorage\.com|AWS4-HMAC-SHA256/);
    }
    // 转录服务只拿到一个 URL：请求体里除了 source.url 没有任何凭据字段
    expect(read("src/transcription/contract.ts")).not.toMatch(/access_key|secret|credential/i);
  });

  it("Cron Trigger 入口存在，并只做 Cloudflare 自有的收敛动作", async () => {
    const cloud = makeCloud();
    const pending: Array<Promise<unknown>> = [];
    await worker.scheduled!({} as ScheduledController, cloud.env, { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(pending);
    expect(cloud.service.log).toEqual([]);
  });

  it("任务 API 在没有转录服务的情况下完整工作（创建 → 排队 → 取消 → 删除）", async () => {
    const cloud = makeCloud();
    cloud.service.offline = true;
    cloud.r2.putSized("uploads/up-1/a.mp3", 100);
    const created = await call(cloud, "/api/control/tasks/custom", "POST", { headers: { "content-type": "application/json" }, body: JSON.stringify({ upload_id: "up-1", title: "x" }) });
    expect(created.status).toBe(202);
    const { task_id } = (await created.json()) as { task_id: string };
    expect(((await (await call(cloud, `/api/control/tasks/${task_id}`)).json()) as { status: string }).status).toBe("pending");
    expect((await call(cloud, `/api/control/tasks/${task_id}`, "DELETE")).status).toBe(200);
    expect(((await (await call(cloud, `/api/control/tasks/${task_id}`)).json()) as { status: string }).status).toBe("cancelled");
    expect(cloud.service.log).toEqual([]);
    void ATTEMPT;
  });
});

describe("运行时契约里没有 Mac / worker 专属词汇", () => {
  it("Env / 配置里不再有 MAC_WORKER_* / EDGE_CALLBACK_TOKEN", () => {
    for (const file of [...runtimeFiles, ".github/workflows/ci.yml"]) {
      const text = read(file);
      expect(text, file).not.toMatch(/MAC_WORKER_(URL|TOKEN)|EDGE_CALLBACK_TOKEN/);
    }
  });

  it("持久化状态枚举里不再有 waiting_worker / downloading（迁移文件本身描述旧词汇，除外）", () => {
    for (const file of runtimeFiles.filter(file => !file.startsWith("migrations/"))) {
      expect(read(file), file).not.toMatch(/waiting_worker|'downloading'\s*\)|"downloading"\s*\|/);
    }
  });

  it("Cloudflare 源码里没有 reclaim / reconcile 外部对账、/jobs/start 派发、Mac-owned 阶段", () => {
    for (const file of walk("src/")) {
      const text = read(file);
      expect(text, file).not.toMatch(/reclaimTasks|reconcileTasks|waitingTasks|updateProgress|storeRaw|fetchRaw|\/jobs\/start|\/jobs\/|Mac-owned|MAC_OWNED|internalHeaders/);
    }
  });

  it("旧的 Mac 专属 workflow / 入口文件已删除", () => {
    for (const file of ["src/workflows/refine.ts", "mac_worker", "transcription_service/worker.py", "transcription_service/executor.py", "transcription_service/adapter.py"]) {
      expect(() => statSync(new URL(file, ROOT))).toThrow();
    }
  });
});

describe("零配置 reference deployment：Mac 侧不持有任何 application config / credential", () => {
  const pythonFiles = walk("transcription_service/").filter(file => file.endsWith(".py") && !file.includes("/test_"));

  it("运行时 Env / 配置里不再有转录服务令牌 / MLX 令牌 / model 选项 / Mac Worker 词汇", () => {
    for (const file of runtimeFiles) {
      expect(read(file), file).not.toMatch(/TRANSCRIPTION_SERVICE_TOKEN|READ_PODCAST_TRANSCRIPTION_SERVICE_TOKEN|READ_PODCAST_WHISPER_API_TOKEN|READ_PODCAST_TRANSCRIPTION_API_KEY|TRANSCRIPTION_MODEL|MAC_WORKER/);
    }
  });

  it("transcription_service 不加载 .env / YAML 配置、不校验 bearer token、没有第二 health 端点", () => {
    for (const file of pythonFiles) {
      const text = read(file);
      expect(text, file).not.toMatch(/load_dotenv|python-dotenv|safe_load|READ_PODCAST_TRANSCRIPTION_CONFIG|READ_PODCAST_WHISPER_API_TOKEN|READ_PODCAST_TRANSCRIPTION_API_KEY|_authorize|Bearer|\/v1\/health/);
    }
  });

  it("deploy/macos 生命周期脚本不生成 application config / secret，也不管理 Tunnel", () => {
    for (const file of walk("deploy/macos/")) {
      const text = read(file);
      expect(text, file).not.toMatch(/\.env|config\.yaml|WHISPER_API_TOKEN|SERVICE_TOKEN|cloudflared/);
    }
  });
});

describe("转录服务代码不持有 Cloudflare 的业务概念", () => {
  const pythonFiles = walk("transcription_service/").filter(file => file.endsWith(".py") && !file.includes("/test_"));

  it("没有回调 / 对账 / attempt / raw 持久化 / 任务状态机", () => {
    expect(pythonFiles.length).toBeGreaterThan(5);
    for (const file of pythonFiles) {
      const text = read(file);
      expect(text, file).not.toMatch(/reclaim_jobs|reconcile_jobs|EDGE_URL|EDGE_CALLBACK|raw_store|raw_fetch|running_attempts|cancel_flags|waiting_worker|current_attempt|\/jobs\/start/);
    }
  });

  it("不包含 Cloudflare 部署配置或凭据的赋值", () => {
    for (const file of [...pythonFiles, ...walk("transcription_service/").filter(file => /\.(yaml|toml|example)$/.test(file))]) {
      expect(read(file), file).not.toMatch(/(?:CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET|R2_ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|GITHUB_TOKEN|REFINER_API_KEY)\s*[:=]/);
    }
  });
});
