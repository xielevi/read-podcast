/**
 * Cloudflare-owned tasks 路由：创建 / 取消 / 重试 / 恢复。
 *
 * 所有权模型：Cloudflare 拥有整条生命周期。
 *   active   : queued / transcribing / refining（+ completion_claimed 的 finalizing 边界）
 *   terminal : success / error / cancelled
 * 转录服务只是被 Workflow 调用的外部计算——这里没有任何「由某个 worker 拥有」的阶段，
 * 没有 reclaim / reconcile / worker 回调：恢复完全由 Cloudflare 自己的 sweep 完成。
 *
 * 全部跑在真实 SQLite 上（CAS 守卫、唯一索引、外键都是真的）。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelOrDeleteTask,
  createCustomTask,
  createTask,
  getTask,
  listTasks,
  mapGlobalProgress,
  reconcileWorkflowLiveness,
  recoverQueuedTasks,
  retryTask,
  runMaintenance,
  toPublicTask,
} from "../src/tasks";
import { getArticle, listArticles } from "../src/articles";
import { MAX_UPLOAD_BYTES } from "../src/limits";
import { processingWorkflowId } from "../src/workflows/processing";
import { ATTEMPT, TASK, ctxStub, insertTask, makeCloud, seedEpisode, taskRow, type Cloud } from "./helpers/cloud";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PODCAST = "忽左忽右";
const TITLE = "474 孙立天谈康熙废储（精修）";
const CREATE_BODY = { episode_id: "ep-1" };

const json = (body: unknown) =>
  new Request("https://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function cloudWithEpisode(): Cloud {
  const cloud = makeCloud();
  seedEpisode(cloud.d1);
  globalThis.fetch = cloud.fetch;
  return cloud;
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const tasksCount = (cloud: Cloud) => (cloud.d1.raw.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;

describe("createTask（POST /tasks）", () => {
  it("正常创建：202 created，任务 queued，并由 Cloudflare 启动 Processing Workflow；不同步联系转录服务", async () => {
    const cloud = cloudWithEpisode();

    const res = await createTask(json(CREATE_BODY), cloud.env, ctxStub);

    expect(res.status).toBe(202);
    const data = (await res.json()) as { task_id: string; status: string };
    expect(data.status).toBe("created");
    expect(data.task_id).toMatch(/^[0-9a-f-]{36}$/);
    const row = taskRow(cloud.d1, data.task_id);
    expect(row).toMatchObject({ status: "queued", source_type: "rss", progress: 0, provider_request_id: null, cancel_requested: 0 });
    expect(row.current_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    // 确定性 workflow id，由 (task_id, current_attempt_id) 派生
    const expectedId = processingWorkflowId(data.task_id, row.current_attempt_id);
    expect(cloud.workflow.created.map(item => item.id)).toEqual([expectedId]);
    // 转录由 Workflow 驱动；创建请求本身不触达转录服务
    expect(cloud.service.log).toEqual([]);
  });

  it("Workflows 暂时不可用：任务仍被接收（202），保持 queued 等待 Cloudflare 自己的 recovery", async () => {
    const cloud = cloudWithEpisode();
    cloud.workflow.createError = new Error("workflows unavailable");

    const res = await createTask(json(CREATE_BODY), cloud.env, ctxStub);

    expect(res.status).toBe(202);
    const { task_id } = (await res.json()) as { task_id: string };
    expect(taskRow(cloud.d1, task_id)).toMatchObject({ status: "queued" });

    // 平台恢复后，recovery sweep 启动它（幂等：确定性 instance id）
    cloud.workflow.createError = null;
    cloud.d1.raw.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ago(120_000), task_id);
    expect(await recoverQueuedTasks(cloud.env)).toBe(1);
    expect(cloud.workflow.created.map(item => item.id)).toEqual([processingWorkflowId(task_id, taskRow(cloud.d1, task_id).current_attempt_id)]);
  });

  it("episode_id 是主路径：按主键创建；「第1期」不会串到更新的「第10期」", async () => {
    const cloud = cloudWithEpisode();
    const insert = cloud.d1.raw.prepare(`INSERT INTO episodes (id, subscription_id, podcast_name, title, audio_url, published_date, source_id)
      VALUES (?, 1, '忽左忽右', ?, ?, ?, ?)`);
    insert.run("1:ep10", "第10期 新的一期", "https://cdn.example.com/10.mp3", "20260601", "ep10");
    insert.run("1:ep1", "第1期", "https://cdn.example.com/1.mp3", "20250101", "ep1");

    const res = await createTask(json({ episode_id: "1:ep1" }), cloud.env, ctxStub);
    expect(res.status).toBe(202);
    const { task_id } = (await res.json()) as { task_id: string };
    expect(taskRow(cloud.d1, task_id)).toMatchObject({ episode_id: "1:ep1", episode_title: "第1期", audio_url: "https://cdn.example.com/1.mp3" });
  });

  it("旧的 {podcast_name, episode_title} 按标题匹配已删除：只接受 episode_id", async () => {
    const cloud = cloudWithEpisode();
    await expect(createTask(json({ podcast_name: PODCAST, episode_title: "474" }), cloud.env, ctxStub)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(tasksCount(cloud)).toBe(0);
  });

  it("episode_id 不存在 → 404，且不回退到标题匹配、不拉 RSS；空 episode_id → 400", async () => {
    const cloud = cloudWithEpisode();
    const res = await createTask(json({ episode_id: "1:missing", podcast_name: PODCAST, episode_title: "474" }), cloud.env, ctxStub);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "episode_not_found" } });
    await expect(createTask(json({ episode_id: " " }), cloud.env, ctxStub)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(tasksCount(cloud)).toBe(0);
  });

  it("已出过正式稿且未 force → 409 already_processed；force=true 绕过", async () => {
    const cloud = cloudWithEpisode();
    insertTask(cloud.d1, { id: "task-old", status: "success", episode_id: "ep-1" });
    cloud.d1.raw.prepare("INSERT INTO articles (task_id, episode_id, title, podcast_name, content_path, commit_sha) VALUES ('task-old', 'ep-1', ?, ?, 'p.md', 'sha')").run(TITLE, PODCAST);

    const blocked = await createTask(json(CREATE_BODY), cloud.env, ctxStub);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "already_processed" } });

    const forced = await createTask(json({ ...CREATE_BODY, force: true }), cloud.env, ctxStub);
    expect(forced.status).toBe(202);
  });

  it("该单集已有活跃任务 → 返回既有任务而不是新建（queued / transcribing / refining 都算活跃，终态不算）", async () => {
    for (const status of ["queued", "transcribing", "refining"]) {
      const cloud = cloudWithEpisode();
      insertTask(cloud.d1, { id: `task-${status}`, status, episode_id: "ep-1" });
      const res = await createTask(json(CREATE_BODY), cloud.env, ctxStub);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ task_id: `task-${status}`, status: "existing" });
      expect(tasksCount(cloud)).toBe(1);
    }
    for (const status of ["error", "cancelled"]) {
      const cloud = cloudWithEpisode();
      insertTask(cloud.d1, { id: `task-${status}`, status, episode_id: "ep-1" });
      expect((await createTask(json(CREATE_BODY), cloud.env, ctxStub)).status).toBe(202);
    }
  });

  it("并发创建：INSERT 撞部分唯一索引 → 回查并返回既有任务（同一 episode 永远只有一个活跃任务）", async () => {
    const cloud = cloudWithEpisode();
    const [a, b] = await Promise.all([createTask(json(CREATE_BODY), cloud.env, ctxStub), createTask(json(CREATE_BODY), cloud.env, ctxStub)]);
    const bodies = [await a.json(), await b.json()] as Array<{ task_id: string; status: string }>;
    expect(new Set(bodies.map(item => item.task_id)).size).toBe(1);
    expect(tasksCount(cloud)).toBe(1);
  });
});

describe("createCustomTask（POST /tasks/custom）与 200 MiB 硬上限", () => {
  const custom = (uploadId = "up-1", extra: Record<string, unknown> = {}) => json({ upload_id: uploadId, title: "我的录音.mp3", ...extra });

  it("上传存在：202，任务 queued，Workflow 已启动（自定义 prompt 被保留）", async () => {
    const cloud = makeCloud();
    cloud.r2.putSized("uploads/up-1/我的录音.mp3", 1024);

    const res = await createCustomTask(custom("up-1", { custom_prompt: "  写成访谈体  " }), cloud.env, ctxStub);

    expect(res.status).toBe(202);
    const { task_id } = (await res.json()) as { task_id: string };
    expect(taskRow(cloud.d1, task_id)).toMatchObject({
      status: "queued",
      source_type: "upload",
      episode_title: "我的录音",
      audio_url: "r2://uploads/up-1/我的录音.mp3",
      custom_prompt: "写成访谈体",
    });
    expect(cloud.workflow.created).toHaveLength(1);
    expect(cloud.service.log).toEqual([]);
  });

  it("上传不存在 → 404 upload_not_found，不建任务", async () => {
    const cloud = makeCloud();
    const res = await createCustomTask(custom("missing"), cloud.env, ctxStub);
    expect(res.status).toBe(404);
    expect(tasksCount(cloud)).toBe(0);
  });

  it.each([
    ["200 MiB − 1 字节", MAX_UPLOAD_BYTES - 1, 202],
    ["恰好 200 MiB", MAX_UPLOAD_BYTES, 202],
    ["200 MiB + 1 字节", MAX_UPLOAD_BYTES + 1, 413],
    ["500 MiB（旧上限）", 500 * 1024 * 1024, 413],
  ])("创建任务时复核真实对象大小：%s → %s", async (_label, size, status) => {
    const cloud = makeCloud();
    cloud.r2.putSized("uploads/up-1/a.mp3", size);

    const res = await createCustomTask(custom(), cloud.env, ctxStub);

    expect(res.status).toBe(status);
    if (status === 413) {
      expect(await res.json()).toMatchObject({ error: { code: "file_too_large" } });
      expect(tasksCount(cloud)).toBe(0);
      expect(cloud.r2.keys("uploads/")).toEqual([]); // 超限对象被销毁，不留 >200 MiB 的合法上传
      expect(cloud.workflow.created).toHaveLength(0);
    } else {
      expect(tasksCount(cloud)).toBe(1);
    }
  });
});

describe("listTasks / getTask", () => {
  it("按 created_at 倒序返回公开任务（纯读，不触发 recovery）", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { id: "t-old", status: "success", episode_id: null, source_type: "upload", audio_url: "r2://uploads/u/a.mp3" });
    cloud.d1.raw.prepare("UPDATE tasks SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = 't-old'").run();
    insertTask(cloud.d1, { id: "t-new", status: "queued", updated_at: ago(120_000) });

    const res = await listTasks(new URL("https://edge.test/api/control/tasks"), cloud.env);

    const data = (await res.json()) as Array<{ id: string }>;
    expect(data.map(item => item.id)).toEqual(["t-new", "t-old"]);
    // GET /tasks 列表是纯读：不触发 recovery、不触碰 Workflow API、不修改 D1
    expect(cloud.workflow.created).toHaveLength(0);
  });

  it("GET /tasks 读纯度：不写 D1、不调用 Workflow API、不触发任何恢复", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { id: "stuck", status: "queued", updated_at: ago(120_000) });
    const beforeRow = taskRow(cloud.d1, "stuck");

    const res = await listTasks(new URL("https://edge.test/api/control/tasks"), cloud.env);
    expect(res.status).toBe(200);

    const afterRow = taskRow(cloud.d1, "stuck");
    expect(afterRow).toEqual(beforeRow);
    expect(cloud.workflow.created).toHaveLength(0);
  });

  it("带 status 时按内部状态过滤；limit 钳制到 [1,200]，非法值回退 20", async () => {
    const cloud = makeCloud();
    for (let i = 0; i < 3; i += 1) insertTask(cloud.d1, { id: `t-${i}`, status: i === 0 ? "refining" : "success", episode_id: null, source_type: "upload", audio_url: "r2://uploads/u/a.mp3" });
    const ids = async (query: string) => ((await (await listTasks(new URL(`https://edge.test/api/control/tasks?${query}`), cloud.env)).json()) as Array<{ id: string }>).map(item => item.id);

    expect(await ids("status=refining")).toEqual(["t-0"]);
    expect(await ids("limit=0")).toHaveLength(1);
    expect(await ids("limit=abc")).toHaveLength(3);
    expect(await ids("limit=9999")).toHaveLength(3);
  });

  it("命中返回公开任务：status 走对外映射，stage 保留内部阶段", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { status: "refining", progress: 80, provider_request_id: "tsr_1", raw_object_key: "raw/x" });

    const data = (await (await getTask(TASK, cloud.env)).json()) as Record<string, unknown>;

    expect(data).toMatchObject({ id: TASK, status: "running", stage: "refining", progress_pct: 80 });
  });

  it("公开任务不泄露内部字段（attempt / workflow / provider 句柄 / raw key / 服务令牌）", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { status: "transcribing", provider_request_id: "tsr_secret", raw_object_key: "raw/secret" });

    const data = (await (await getTask(TASK, cloud.env)).json()) as Record<string, unknown>;

    expect(Object.keys(data).sort()).toEqual(["created_at", "episode_id", "episode_title", "id", "message", "podcast_name", "progress_pct", "stage", "status", "updated_at"]);
    const text = JSON.stringify(data);
    for (const secret of ["wf-secret", "tsr_secret", "raw/secret", ATTEMPT, "svc-token"]) expect(text).not.toContain(secret);
  });

  it("不存在 → 404 task_not_found", async () => {
    const cloud = makeCloud();
    const res = await getTask(TASK, cloud.env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "task_not_found", message: "Task not found" } });
  });
});

describe("进度映射与公开状态", () => {
  it("mapGlobalProgress 单调映射各阶段区间", () => {
    expect(mapGlobalProgress("downloading", 0)).toBe(0);
    expect(mapGlobalProgress("downloading", 100)).toBe(25);
    expect(mapGlobalProgress("transcribing", 0)).toBe(25);
    expect(mapGlobalProgress("transcribing", 100)).toBe(65);
    expect(mapGlobalProgress("refining", 0)).toBe(65);
    expect(mapGlobalProgress("refining", 100)).toBe(95);
    expect(mapGlobalProgress("finalizing", 100)).toBe(100);
    expect(mapGlobalProgress("success", 0)).toBe(100);
    expect(mapGlobalProgress("transcribing", 250)).toBe(65); // 钳制
    expect(mapGlobalProgress("transcribing", -5)).toBe(25);
  });

  const base = { id: "x", episode_id: null, source_type: "rss", podcast_name: "p", episode_title: "e", audio_url: null, progress: 30, message: "m", current_attempt_id: "a", cancel_requested: 0, raw_object_key: null, provider_request_id: null, transcription_phase: null, error_code: null, created_at: "c", updated_at: "u" } as const;

  it.each([
    ["queued", null, "pending", "queued"],
    ["transcribing", "fetching", "running", "downloading"],
    ["transcribing", "preparing", "running", "downloading"],
    ["transcribing", null, "running", "downloading"],
    ["transcribing", "transcribing", "running", "transcribing"],
    ["refining", null, "running", "refining"],
    ["finalizing", null, "running", "finalizing"],
    ["error", null, "failed", "error"],
    ["cancelled", null, "cancelled", "cancelled"],
  ])("状态 %s（phase=%s）→ 对外 status=%s / stage=%s", (status, phase, publicStatus, stage) => {
    expect(toPublicTask({ ...base, status, transcription_phase: phase } as never)).toMatchObject({ status: publicStatus, stage });
  });

  it("finalizing 状态展示为 finalizing/95+；success 恒为 100", () => {
    const finalizing = toPublicTask({ ...base, status: "finalizing", progress: 95, message: "正在保存正式稿…" } as never);
    expect(finalizing).toMatchObject({ stage: "finalizing", status: "running", progress_pct: 95, message: "正在保存正式稿…" });
    expect(toPublicTask({ ...base, status: "success", progress: 12 } as never)).toMatchObject({ stage: "success", status: "success", progress_pct: 100 });
  });
});

describe("取消：Cloudflare 是唯一权威", () => {
  async function activeTask(status: string, seed: Record<string, unknown> = {}) {
    const cloud = makeCloud();
    globalThis.fetch = cloud.fetch;
    const wf = processingWorkflowId(TASK, ATTEMPT);
    insertTask(cloud.d1, { status, ...seed });
    await cloud.workflow.create({ id: wf, params: {} });
    return { cloud, wf };
  }

  it("queued：直接 cancelled，Workflow 被终止；没有提交过转录请求就不联系转录服务", async () => {
    const { cloud, wf } = await activeTask("queued");
    const res = await cancelOrDeleteTask(TASK, cloud.env, ctxStub);
    await ctxStub.settle();

    expect(await res.json()).toEqual({ task_id: TASK, status: "cancelled" });
    expect(taskRow(cloud.d1)).toMatchObject({ status: "cancelled", message: "任务已取消" });
    expect(cloud.workflow.instances.get(wf)?.terminated).toBe(true);
    expect(cloud.service.log).toEqual([]);
  });

  it("transcribing：D1 cancelled + Workflow 终止 + 尽力通知转录服务取消（服务无响应也不影响结论）", async () => {
    const { cloud, wf } = await activeTask("transcribing", { provider_request_id: "tsr_0007" });
    cloud.service.offline = true;

    const res = await cancelOrDeleteTask(TASK, cloud.env, ctxStub);
    await ctxStub.settle();

    expect(res.status).toBe(200);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "cancelled", cancel_requested: 1 });
    expect(cloud.workflow.instances.get(wf)?.terminated).toBe(true);
  });

  it("transcribing：服务在线时收到对该 provider 请求的 DELETE", async () => {
    const { cloud } = await activeTask("transcribing", { provider_request_id: "tsr_0007" });
    await cancelOrDeleteTask(TASK, cloud.env, ctxStub);
    await ctxStub.settle();
    expect(cloud.service.deletes.map(entry => entry.path)).toEqual(["/v1/transcriptions/tsr_0007"]);
  });

  it("refining：CAS → terminate Workflow → cancelled，且不联系转录服务", async () => {
    const { cloud, wf } = await activeTask("refining", { raw_object_key: "raw/x" });
    await cancelOrDeleteTask(TASK, cloud.env, ctxStub);
    await ctxStub.settle();
    expect(taskRow(cloud.d1).status).toBe("cancelled");
    expect(cloud.workflow.instances.get(wf)?.terminated).toBe(true);
    expect(cloud.service.log).toEqual([]);
  });

  it("status = finalizing：409 finalizing（不可取消边界），任务不变", async () => {
    const { cloud } = await activeTask("finalizing");
    const res = await cancelOrDeleteTask(TASK, cloud.env, ctxStub);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "finalizing" } });
    expect(taskRow(cloud.d1)).toMatchObject({ status: "finalizing", cancel_requested: 0 });
  });

  it("cancel vs finalizing 竞争：finalizing 胜出返回 409；cancel 胜出时 cancel_requested 阻断 publish CAS", async () => {
    // 1. finalizing 胜出：status 已是 finalizing，cancel 请求被 409 拒绝
    const cloud1 = makeCloud();
    insertTask(cloud1.d1, { status: "finalizing" });
    const res1 = await cancelOrDeleteTask(TASK, cloud1.env, ctxStub);
    expect(res1.status).toBe(409);
    expect(await res1.json()).toMatchObject({ error: { code: "finalizing" } });

    // 2. cancel 胜出：cancelOrDeleteTask 成功将任务置为 cancelled 并设置 cancel_requested = 1
    const cloud2 = makeCloud();
    insertTask(cloud2.d1, { status: "refining" });
    const res2 = await cancelOrDeleteTask(TASK, cloud2.env, ctxStub);
    expect(res2.status).toBe(200);
    expect(taskRow(cloud2.d1)).toMatchObject({ status: "cancelled", cancel_requested: 1 });
  });

  it("success：409 task_completed（稿件保留在稿件库）", async () => {
    const { cloud } = await activeTask("success");
    const res = await cancelOrDeleteTask(TASK, cloud.env, ctxStub);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "task_completed" } });
  });

  it("终态失败 / 已取消：删除任务并清理其 raw lineage", async () => {
    for (const status of ["error", "cancelled"]) {
      const { cloud } = await activeTask(status);
      await cloud.r2.put(`raw/${TASK}/${ATTEMPT}.txt`, "x");
      const res = await cancelOrDeleteTask(TASK, cloud.env, ctxStub);
      await ctxStub.settle();
      expect(await res.json()).toEqual({ task_id: TASK, status: "deleted" });
      expect(tasksCount(cloud)).toBe(0);
      expect(cloud.r2.keys("raw/")).toEqual([]);
    }
  });

  it("不存在 → 404", async () => {
    const cloud = makeCloud();
    expect((await cancelOrDeleteTask(TASK, cloud.env, ctxStub)).status).toBe(404);
  });
});

describe("retry：任务级重试永远是「新 attempt → 新 Processing Workflow」", () => {
  const RAW_KEY = `raw/${TASK}/${ATTEMPT}.txt`;

  function failed(cloud: Cloud, seed: Record<string, unknown> = {}) {
    insertTask(cloud.d1, { status: "error", error_code: "refine_quality_gate", progress: 90, ...seed });
    globalThis.fetch = cloud.fetch;
  }

  it("raw 存在 → queued + 保留 raw + 新 Workflow；此时完全不联系转录服务", async () => {
    const cloud = makeCloud();
    failed(cloud, { raw_object_key: RAW_KEY });
    await cloud.r2.put(RAW_KEY, "raw text");

    const res = await retryTask(TASK, cloud.env, ctxStub);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ task_id: TASK, status: "queued" });
    const row = taskRow(cloud.d1);
    expect(row).toMatchObject({ status: "queued", progress: 0, raw_object_key: RAW_KEY, error_code: null, provider_request_id: null, cancel_requested: 0 });
    expect(row.current_attempt_id).not.toBe(ATTEMPT);
    expect(cloud.workflow.created.map(item => item.id)).toEqual([processingWorkflowId(TASK, row.current_attempt_id)]);
    expect(cloud.service.log).toEqual([]);
  });

  it("raw_object_key 为空但 R2 前缀下有历史 raw → 同样命中并复用", async () => {
    const cloud = makeCloud();
    failed(cloud, { raw_object_key: null });
    await cloud.r2.put(`raw/${TASK}/older-attempt.txt`, "raw text");

    await retryTask(TASK, cloud.env, ctxStub);

    expect(taskRow(cloud.d1).raw_object_key).toBe(`raw/${TASK}/older-attempt.txt`);
  });

  it.each(["refine_raw_too_short", "transcription_invalid"])("bad raw（%s）：整条 raw lineage 被清空，回到重新转录（不进入 raw-only 循环）", async code => {
    const cloud = makeCloud();
    failed(cloud, { error_code: code, raw_object_key: RAW_KEY });
    await cloud.r2.put(RAW_KEY, "短");
    await cloud.r2.put(`raw/${TASK}/older.txt`, "历史也是坏的");

    const res = await retryTask(TASK, cloud.env, ctxStub);

    expect(res.status).toBe(202);
    expect(cloud.r2.keys("raw/")).toEqual([]);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "queued", raw_object_key: null });
  });

  it("自定义上传：raw 缺失但原音频仍在 → 重新转录", async () => {
    const cloud = makeCloud();
    failed(cloud, { source_type: "upload", audio_url: "r2://uploads/up-1/a.mp3", error_code: "transcription_invalid", episode_id: null });
    cloud.r2.putSized("uploads/up-1/a.mp3", 1000);

    expect((await retryTask(TASK, cloud.env, ctxStub)).status).toBe(202);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "queued", raw_object_key: null });
  });

  it("自定义上传：raw 与原音频都没了 → 409 upload_expired，任务保持原状", async () => {
    const cloud = makeCloud();
    failed(cloud, { source_type: "upload", audio_url: "r2://uploads/gone/a.mp3", error_code: "transcription_invalid", episode_id: null });

    const res = await retryTask(TASK, cloud.env, ctxStub);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "upload_expired" } });
    expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "transcription_invalid" });
    expect(cloud.workflow.created).toHaveLength(0);
  });

  it("RSS 且 raw 缺失 → 重新转录（queued，由 Workflow 的 resolve-raw / 提交决定）", async () => {
    const cloud = makeCloud();
    failed(cloud, { error_code: "transcription_service_unavailable" });
    expect((await retryTask(TASK, cloud.env, ctxStub)).status).toBe(202);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "queued", raw_object_key: null });
  });

  it("失败与已取消都可重试；其余状态 409 task_not_retriable", async () => {
    for (const status of ["queued", "transcribing", "refining", "success"]) {
      const cloud = makeCloud();
      insertTask(cloud.d1, { status });
      const res = await retryTask(TASK, cloud.env, ctxStub);
      expect(res.status, status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: "task_not_retriable" } });
    }
    const cloud = makeCloud();
    insertTask(cloud.d1, { status: "cancelled" });
    globalThis.fetch = cloud.fetch;
    expect((await retryTask(TASK, cloud.env, ctxStub)).status).toBe(202);
  });

  it("Workflow 启动失败：任务仍是 queued，由 recovery 接手（不丢、不僵死）", async () => {
    const cloud = makeCloud();
    failed(cloud, { raw_object_key: RAW_KEY });
    await cloud.r2.put(RAW_KEY, "raw");
    cloud.workflow.createError = new Error("boom");

    const res = await retryTask(TASK, cloud.env, ctxStub);

    expect(res.status).toBe(202);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "queued" });
  });

  it("同一 episode 已有另一个活跃任务 → 409 episode_active（唯一索引），本任务保持失败态", async () => {
    const cloud = cloudWithEpisode();
    insertTask(cloud.d1, { id: "other", status: "queued", episode_id: "ep-1" });
    insertTask(cloud.d1, { status: "error", episode_id: "ep-1" });

    const res = await retryTask(TASK, cloud.env, ctxStub);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "episode_active" } });
    expect(taskRow(cloud.d1).status).toBe("error");
  });

  it("不存在 → 404", async () => {
    const cloud = makeCloud();
    expect((await retryTask(TASK, cloud.env, ctxStub)).status).toBe(404);
  });
});

describe("recovery：完全由 Cloudflare 自己的 sweep 完成（没有 reclaim / reconcile / worker 回调）", () => {
  it("queued 且未启动 Workflow 的任务被补启动；刚创建的（<45s）不抢在创建请求前面", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { id: "stuck", status: "queued", updated_at: ago(120_000) });
    insertTask(cloud.d1, { id: "fresh", status: "queued", episode_id: null, source_type: "upload", audio_url: "r2://uploads/x/a.mp3", updated_at: ago(1_000) });

    expect(await recoverQueuedTasks(cloud.env)).toBe(1);

    expect(cloud.workflow.created.map(item => item.id)).toEqual([processingWorkflowId("stuck", taskRow(cloud.d1, "stuck").current_attempt_id)]);
  });

  it("recovery 幂等：已有 instance 不会被重复创建", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { status: "queued", updated_at: ago(120_000) });
    await recoverQueuedTasks(cloud.env);
    expect(cloud.workflow.created).toHaveLength(1);

    // 再次调用 recovery，因 instance 已存在，不重复创建
    await recoverQueuedTasks(cloud.env);
    expect(cloud.workflow.created).toHaveLength(1);
  });

  it("升级迁移后重新排队的任务：raw 已在 R2 的会被同一套 recovery 启动（不需要任何外部节点）", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { status: "queued", raw_object_key: `raw/${TASK}/old.txt`, updated_at: ago(120_000), message: "系统升级：已重新排队，由 Cloudflare 继续调度" });
    await recoverQueuedTasks(cloud.env);
    expect(cloud.workflow.created).toHaveLength(1);
  });

  it("超过 30 分钟仍启动不了 Workflow → 转 error（workflow_unavailable，可重试），不永久停在 queued", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { status: "queued", updated_at: ago(31 * 60_000) });

    await recoverQueuedTasks(cloud.env);

    expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "workflow_unavailable" });
  });

  it("平台仍不可用时 recovery 不抛错，任务继续保持 queued", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { status: "queued", updated_at: ago(120_000) });
    cloud.workflow.createError = new Error("down");
    expect(await recoverQueuedTasks(cloud.env)).toBe(0);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "queued" });
  });

  it("已取消的任务不会被 recovery 启动", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { id: "a", status: "queued", cancel_requested: 1, updated_at: ago(120_000) });
    expect(await recoverQueuedTasks(cloud.env)).toBe(0);
  });

  describe("Workflow 存活对账", () => {
    async function withWorkflow(status: string, seed: Record<string, unknown> = {}, workflowStatus = "running", agoMs = 40 * 60_000) {
      const cloud = makeCloud();
      const wf = processingWorkflowId(TASK, ATTEMPT);
      insertTask(cloud.d1, { status, updated_at: ago(agoMs), ...seed });
      await cloud.workflow.create({ id: wf, params: {} });
      cloud.workflow.instances.get(wf)!.status = workflowStatus;
      return cloud;
    }

    it.each(["errored", "terminated", "complete"])("Workflow 已 %s 而 D1 仍活跃 → error(workflow_lost)，raw 保留可重试", async workflowStatus => {
      for (const status of ["queued", "transcribing", "refining"]) {
        const cloud = await withWorkflow(status, { raw_object_key: "raw/keep" }, workflowStatus);
        expect(await reconcileWorkflowLiveness(cloud.env)).toBe(1);
        expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "workflow_lost", raw_object_key: "raw/keep" });
      }
    });

    it("finalizing 状态超过 10 分钟且 Workflow 明确已死 → error(workflow_lost)", async () => {
      const cloud = await withWorkflow("finalizing", { raw_object_key: "raw/keep" }, "errored", 11 * 60_000);
      expect(await reconcileWorkflowLiveness(cloud.env)).toBe(1);
      expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "workflow_lost" });
    });

    it("finalizing 状态下 status 查询返回 null（查询失败）且未超 6 小时 → 不收敛（保守兜底）", async () => {
      const cloud = makeCloud();
      insertTask(cloud.d1, { status: "finalizing", updated_at: ago(20 * 60_000) });
      // 不在 mock workflow 中创建 instance，从而 processingWorkflowStatus 返回 null
      expect(await reconcileWorkflowLiveness(cloud.env)).toBe(0);
      expect(taskRow(cloud.d1).status).toBe("finalizing");
    });

    it("status 为 null 超过 6 小时极端兜底 → 收敛为 error(workflow_lost)", async () => {
      const cloud = makeCloud();
      insertTask(cloud.d1, { status: "finalizing", updated_at: ago(7 * 3_600_000) });
      expect(await reconcileWorkflowLiveness(cloud.env)).toBe(1);
      expect(taskRow(cloud.d1)).toMatchObject({ status: "error", error_code: "workflow_lost" });
    });

    it("finalizing 状态未超过 10 分钟 → 即使 Workflow errored 也不被对账（留给同 attempt 重试窗口）", async () => {
      const cloud = await withWorkflow("finalizing", {}, "errored", 5 * 60_000);
      expect(await reconcileWorkflowLiveness(cloud.env)).toBe(0);
      expect(taskRow(cloud.d1).status).toBe("finalizing");
    });

    it("Workflow 仍在运行（包括长时间转录 / 服务离线中的 durable retry）→ 不动", async () => {
      const cloud = await withWorkflow("transcribing", {}, "running");
      expect(await reconcileWorkflowLiveness(cloud.env)).toBe(0);
      expect(taskRow(cloud.d1).status).toBe("transcribing");
    });

    it("近期有心跳（updated_at 新）的任务不参与对账", async () => {
      const cloud = await withWorkflow("transcribing", { updated_at: ago(60_000) }, "errored");
      expect(await reconcileWorkflowLiveness(cloud.env)).toBe(0);
    });

    it("取消中的任务不参与对账", async () => {
      const cloud = await withWorkflow("refining", { cancel_requested: 1 }, "errored");
      expect(await reconcileWorkflowLiveness(cloud.env)).toBe(0);
    });
  });

  it("runMaintenance（cron 入口）两类收敛互相独立地执行", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { id: "stuck", status: "queued", episode_id: null, source_type: "upload", audio_url: "r2://uploads/x/a.mp3", updated_at: ago(120_000) });
    const wf = processingWorkflowId("dead", ATTEMPT);
    insertTask(cloud.d1, { id: "dead", status: "transcribing", episode_id: null, source_type: "upload", audio_url: "r2://uploads/y/a.mp3", updated_at: ago(40 * 60_000) });
    await cloud.workflow.create({ id: wf, params: {} });
    cloud.workflow.instances.get(wf)!.status = "errored";

    expect(await runMaintenance(cloud.env)).toEqual({ started: 1, lost: 1 });
  });
});

describe("Library 与执行任务解耦（articles 为 SSOT）", () => {
  it("listArticles / getArticle 从 articles 读取", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { id: "task-latest", status: "success", episode_id: "ep-1" });
    cloud.d1.raw.prepare("INSERT INTO articles (task_id, episode_id, title, podcast_name, content_path, commit_sha) VALUES ('task-latest', 'ep-1', '单集1', '播客A', 'p.md', 'sha')").run();

    expect(((await (await listArticles(new URL("https://x/api/control/articles?limit=50"), cloud.env)).json()) as unknown[]).length).toBe(1);
    expect((await getArticle("task-latest", cloud.env)).status).toBe(200);
  });

  it("listTasks?active=true 只返回进行中的任务（前端单一轮询器每轮只发这一个请求）", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { id: "t-queued", status: "queued", episode_id: null });
    insertTask(cloud.d1, { id: "t-refining", status: "refining", episode_id: null });
    insertTask(cloud.d1, { id: "t-success", status: "success", episode_id: null });
    insertTask(cloud.d1, { id: "t-error", status: "error", episode_id: null });
    const tasks = (await (await listTasks(new URL("https://x/api/control/tasks?active=true"), cloud.env)).json()) as Array<{ id: string; status: string }>;
    expect(tasks.map(task => task.id).sort()).toEqual(["t-queued", "t-refining"]);
    expect(tasks.every(task => task.status === "pending" || task.status === "running")).toBe(true);
  });

  it("listArticles：非数字 limit / offset 回退默认值，而不是把 NaN 交给 D1", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { id: "task-latest", status: "success", episode_id: "ep-1" });
    cloud.d1.raw.prepare("INSERT INTO articles (task_id, episode_id, title, podcast_name, content_path, commit_sha) VALUES ('task-latest', 'ep-1', '单集1', '播客A', 'p.md', 'sha')").run();

    const articles = await listArticles(new URL("https://x/api/control/articles?limit=abc&offset=abc"), cloud.env);
    expect(articles.status).toBe(200);
    expect(((await articles.json()) as unknown[]).length).toBe(1);
  });
});
