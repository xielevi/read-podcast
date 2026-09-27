/**
 * Edge 订阅路由测试。
 *
 * 覆盖 listSubscriptions / createSubscription / deleteSubscription：
 * - 输出形状对齐前端消费的 PODCASTS 对象（name / rss_url / image / enabled）；
 * - createSubscription 必须校验 RSS 可达（502 rss_unreachable）并做封面回退；
 * - deleteSubscription 用 changes 区分 204 与 404。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubscription, deleteSubscription } from "../src/subscriptions";
import { listSubscriptions } from "../src/episodes";
import { HttpError } from "../src/http";
import type { Env } from "../src/types";

const FEED = "https://example.com/feed.xml";

const CHANNEL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>忽左忽右</title>
    <itunes:image href="https://example.com/channel-cover.jpg" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"/>
    <item>
      <title>475 某期</title>
      <enclosure url="https://example.com/475.mp3" type="audio/mpeg" length="12345"/>
    </item>
  </channel>
</rss>`;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonRequest(body: unknown, url = "https://edge.test/api/control/subscriptions"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 记录 SQL 与绑定参数的最小 D1 fake。 */
function mockEnv(options: {
  rows?: Array<{ name: string; rss_url: string; image_url: string }>;
  upserted?: { name: string; rss_url: string; image_url: string } | null;
  changes?: number;
} = {}) {
  const calls = { sql: [] as string[], bound: [] as unknown[][] };

  const statementFor = (sql: string) => {
    calls.sql.push(sql);
    const bound: unknown[] = [];
    calls.bound.push(bound);
    return {
      bind: (...args: unknown[]) => {
        bound.push(...args);
        return {
          first: async () => options.upserted ?? null,
          all: async () => ({ results: options.rows ?? [] }),
          run: async () => ({ meta: { changes: options.changes ?? 1 } }),
        };
      },
      first: async () => options.upserted ?? null,
      all: async () => ({ results: options.rows ?? [] }),
      run: async () => ({ meta: { changes: options.changes ?? 1 } }),
    };
  };

  const batches: number[] = [];
  const db = { prepare: statementFor, batch: async (statements: unknown[]) => { batches.push(statements.length); return []; } };
  return {
    env: { db, DB: db } as unknown as Env,
    calls,
    batches,
  };
}

function mockFeed(xml: string | null, status = 200) {
  globalThis.fetch = vi.fn(async () => {
    if (xml === null) return new Response("nope", { status });
    return new Response(xml, { status, headers: { "content-type": "application/xml" } });
  }) as typeof globalThis.fetch;
}

describe("listSubscriptions", () => {
  it("输出 name / rss_url / image / enabled，image_url 空值时回退为空串", async () => {
    const { env } = mockEnv({
      rows: [
        { name: "东腔西调", rss_url: "https://example.com/a.xml", image_url: "" },
        { name: "忽左忽右", rss_url: "https://example.com/b.xml", image_url: "https://example.com/c.jpg" },
      ],
    });

    const res = await listSubscriptions(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { name: "东腔西调", rss_url: "https://example.com/a.xml", image: "", enabled: true },
      { name: "忽左忽右", rss_url: "https://example.com/b.xml", image: "https://example.com/c.jpg", enabled: true },
    ]);
  });

  it("空库返回空数组而不是 null", async () => {
    const { env } = mockEnv({ rows: [] });
    expect(await (await listSubscriptions(env)).json()).toEqual([]);
  });
});

describe("createSubscription", () => {
  it("缺少 name 时从 RSS 自动识别节目名称", async () => {
    const { env, calls } = mockEnv({ upserted: { name: "忽左忽右", rss_url: FEED, image_url: "https://example.com/channel-cover.jpg" } });
    mockFeed(CHANNEL_XML);
    const res = await createSubscription(jsonRequest({ name: "", rss_url: FEED }), env);
    expect(res.status).toBe(201);
    const [name] = calls.bound.find((_, i) => calls.sql[i]?.includes("INSERT INTO subscriptions")) ?? [];
    expect(name).toBe("忽左忽右");
  });

  it("非公网 rss_url 被 assertPublicHttpUrl 拒绝（不发起 fetch）", async () => {
    const { env } = mockEnv();
    mockFeed(CHANNEL_XML);
    await expect(createSubscription(jsonRequest({ name: "x", rss_url: "http://127.0.0.1/feed.xml" }), env)).rejects.toThrow(
      "URL resolves to a non-public host",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("RSS 不可达 → 502 rss_unreachable，且不写库", async () => {
    const { env, calls } = mockEnv();
    mockFeed(null, 500);

    await expect(createSubscription(jsonRequest({ name: "x", rss_url: FEED }), env)).rejects.toMatchObject({
      status: 502,
      code: "rss_unreachable",
    });
    expect(calls.sql).toHaveLength(0);
  });

  it("成功：201，rss_url 归一化后写库，图片缺省回退到频道封面", async () => {
    const { env, calls } = mockEnv({
      upserted: { name: "忽左忽右", rss_url: FEED, image_url: "https://example.com/channel-cover.jpg" },
    });
    mockFeed(CHANNEL_XML);

    const res = await createSubscription(jsonRequest({ name: "忽左忽右", rss_url: FEED }), env);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      name: "忽左忽右",
      rss_url: FEED,
      image: "https://example.com/channel-cover.jpg",
      enabled: true,
    });

    const upsert = calls.sql.find(sql => sql.includes("INSERT INTO subscriptions"));
    expect(upsert).toContain("ON CONFLICT(name) DO UPDATE");
  });

  it("校验时解析过的单集直接入库（一条单集 + 同步时间），首次打开节目不必再拉 RSS", async () => {
    const { env, calls, batches } = mockEnv({
      upserted: { name: "忽左忽右", rss_url: FEED, image_url: "" },
    });
    mockFeed(CHANNEL_XML);

    expect((await createSubscription(jsonRequest({ name: "忽左忽右", rss_url: FEED }), env)).status).toBe(201);
    expect(batches).toEqual([2]);
    expect(calls.sql.some(sql => sql.includes("INSERT INTO episodes"))).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("显式提供的封面优先于频道封面", async () => {
    const { env, calls } = mockEnv({
      upserted: { name: "x", rss_url: FEED, image_url: "https://example.com/mine.jpg" },
    });
    mockFeed(CHANNEL_XML);

    await createSubscription(jsonRequest({ name: "x", rss_url: FEED, image: "https://example.com/mine.jpg" }), env);
    const [, , imageArg] = calls.bound.find((_, i) => calls.sql[i]?.includes("INSERT INTO subscriptions")) ?? [];
    expect(imageArg).toBe("https://example.com/mine.jpg");
  });

  it("image_url 是 image 的兼容别名", async () => {
    const { env, calls } = mockEnv({
      upserted: { name: "x", rss_url: FEED, image_url: "https://example.com/alias.jpg" },
    });
    mockFeed(CHANNEL_XML);

    await createSubscription(jsonRequest({ name: "x", rss_url: FEED, image_url: "https://example.com/alias.jpg" }), env);
    const [, , imageArg] = calls.bound.find((_, i) => calls.sql[i]?.includes("INSERT INTO subscriptions")) ?? [];
    expect(imageArg).toBe("https://example.com/alias.jpg");
  });
});

describe("deleteSubscription", () => {
  it("命中 → 204 空响应", async () => {
    const { env, calls } = mockEnv({ changes: 1 });
    const res = await deleteSubscription("忽左忽右", env);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(calls.sql[0]).toContain("DELETE FROM subscriptions");
  });

  it("未命中 → 404 subscription_not_found", async () => {
    const { env } = mockEnv({ changes: 0 });
    const res = await deleteSubscription("不存在", env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "subscription_not_found", message: "Subscription not found" } });
  });

  it("对 URI 编码的路径参数做解码", async () => {
    const { env, calls } = mockEnv({ changes: 1 });
    await deleteSubscription(encodeURIComponent("忽左忽右"), env);
    expect(calls.bound[0][0]).toBe("忽左忽右");
  });
});
