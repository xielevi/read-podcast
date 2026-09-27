/**
 * Settings 聚合层测试（Cloudflare 拥有全部可编辑配置）。
 *
 *   Cloudflare : refiner.*（D1 refiner_settings）；REFINER_API_KEY 只在 Wrangler Secret
 *   转录服务   : endpoint / Cloudflare Access 凭据是 Cloudflare 的部署配置（只读展示 + 连通性探针）；
 *                转录后端 / 并发 / 体积上限属于转录服务本机的 built-in defaults，Mac 上没有任何 secret。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSettings, putSettings, testSettings } from "../src/settings";
import { ACCESS_CLIENT_SECRET, makeCloud, type Cloud } from "./helpers/cloud";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

type Group = { key: string; title?: string; fields: Array<Record<string, unknown>> };
const groupsOf = async (res: Response) => ((await res.json()) as { groups: Group[] }).groups;

const put = (values: Record<string, unknown>) =>
  new Request("https://edge/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values }) });
const test = (target: string) =>
  new Request("https://edge/settings/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }) });

function cloud(): Cloud {
  const c = makeCloud();
  globalThis.fetch = c.fetch;
  return c;
}

describe("GET /settings", () => {
  it("设置页只返回文字整理与完整度保护", async () => {
    const c = cloud();
    const groups = await groupsOf(await getSettings(c.env));

    expect(groups.map(group => group.key)).toEqual(["refiner", "quality"]);
    expect(groups[0].fields.map(field => field.label)).toContain("模型");
    expect(groups[1].title).toBe("完整度保护");
  });

  it("转录服务不可达：设置页仍然可用（精修配置不受影响），状态如实反映", async () => {
    const c = cloud();
    c.service.offline = true;
    const raw = await (await getSettings(c.env)).text();
    const groups = (JSON.parse(raw) as { groups: Group[] }).groups;

    expect(groups.map(group => group.key)).toEqual(["refiner", "quality"]);
  });

  it("绝不返回任何密钥值；只有 configured 徽标", async () => {
    const c = cloud();
    const raw = await (await getSettings(c.env)).text();
    expect(raw).not.toContain("secret.REFINER_API_KEY");
    expect(raw).not.toContain("access.transcription");
    for (const secret of ["test-key", ACCESS_CLIENT_SECRET, "signing-key-0123456789abcdef", "gh-token"]) expect(raw).not.toContain(secret);
  });

  it("未配置转录服务：明确显示，不抛错", async () => {
    const c = cloud();
    Object.assign(c.env, { TRANSCRIPTION_SERVICE_URL: "", CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" });
    const groups = await groupsOf(await getSettings(c.env));
    expect(groups.map(group => group.key)).toEqual(["refiner", "quality"]);
  });

  it("不再向任何外部节点读取配置：请求转录服务的只有 /health", async () => {
    const c = cloud();
    await getSettings(c.env);
    expect(c.service.log).toEqual([]);
    // 探针不创建任何真实 transcription request
    expect(c.service.posts).toEqual([]);
    expect(c.service.jobs.size).toBe(0);
  });
});

describe("PUT /settings", () => {
  it("refiner.* 只写 D1，不联系任何外部服务", async () => {
    const c = cloud();
    const fetchSpy = vi.fn(c.fetch);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await putSettings(put({ "refiner.model": "new-model", "refiner.temperature": "0.5" }), c.env);

    const row = c.d1.raw.prepare("SELECT model, temperature FROM refiner_settings WHERE id = 1").get();
    expect({ ...row }).toEqual({ model: "new-model", temperature: 0.5 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["transcription.backend", "transcription.timeout", "runtime.download_concurrency", "access.transcription", "health.transcription"])(
    "%s 不由 Cloudflare 管理 → 400 unsupported_setting（不会被转发给任何服务）",
    async key => {
      const c = cloud();
      await expect(putSettings(put({ [key]: "x" }), c.env)).rejects.toMatchObject({ status: 400, code: "unsupported_setting" });
      expect(c.service.log).toEqual([]);
    },
  );

  it("混合提交中含不受支持的键 → 整体拒绝，不写入半成品", async () => {
    const c = cloud();
    await expect(putSettings(put({ "refiner.model": "m2", "transcription.backend": "x" }), c.env)).rejects.toMatchObject({ code: "unsupported_setting" });
    expect((c.d1.raw.prepare("SELECT model FROM refiner_settings WHERE id = 1").get() as { model: string }).model).not.toBe("m2");
  });

  it("非法 refiner 值 → 抛错（绝不写入半成品）", async () => {
    const c = cloud();
    await expect(putSettings(put({ "refiner.temperature": "9" }), c.env)).rejects.toThrow();
  });
});

describe("POST /settings/test", () => {
  it("target=refiner 在 Cloudflare 侧直连服务商（不经过转录服务）", async () => {
    const c = cloud();
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await testSettings(test("refiner"), c.env);

    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(calls[0]).toBe("https://opencode.ai/zen/go/v1/models");
    expect(calls.some(url => url.includes("transcribe.test"))).toBe(false);
  });

  it("target=refiner 且未注入 secret → 明确提示", async () => {
    const c = cloud();
    Object.assign(c.env, { REFINER_API_KEY: "" });
    const data = (await (await testSettings(test("refiner"), c.env)).json()) as { ok: boolean; detail: string };
    expect(data.ok).toBe(false);
    expect(data.detail).toContain("REFINER_API_KEY");
  });

  it("target=transcription：探测 /health（经 Access），返回延迟", async () => {
    const c = cloud();
    const res = await testSettings(test("transcription"), c.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, detail: expect.stringContaining("连接正常") });
    expect(c.service.log.map(entry => entry.path)).toEqual(["/health"]);
  });

  it("target=transcription：Access 凭据配错 → 明确失败（不是显示「服务正常」）", async () => {
    const c = cloud();
    (c.env as unknown as Record<string, string>).CF_ACCESS_CLIENT_SECRET = "wrong-secret";

    const res = await testSettings(test("transcription"), c.env);

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "transcription_service_unreachable" } });
  });

  it("target=transcription：未配置 Access 凭据 → 明确失败，而不是「服务正常」", async () => {
    const c = cloud();
    (c.env as unknown as Record<string, string>).CF_ACCESS_CLIENT_ID = "";
    (c.env as unknown as Record<string, string>).CF_ACCESS_CLIENT_SECRET = "";

    const res = await testSettings(test("transcription"), c.env);

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "transcription_service_unreachable" } });
  });

  it("target=transcription：服务离线 → 502 transcription_service_unreachable", async () => {
    const c = cloud();
    c.service.offline = true;
    const res = await testSettings(test("transcription"), c.env);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "transcription_service_unreachable" } });
  });

  it("非法 target 报错", async () => {
    await expect(testSettings(test("unsupported"), cloud().env)).rejects.toThrow("Target must be 'transcription' or 'refiner'");
  });
});
