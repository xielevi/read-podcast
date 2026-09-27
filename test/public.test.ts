/**
 * Public Browse Mode 与 Authenticated Control Mode 的 API 边界。
 *
 *   /api/public/*  匿名可访问，严格只读：不写 D1 / R2、不刷新外部源（RSS）、不启动任务、不调用模型，
 *                  不暴露任务 / 已读 / 设置等控制面状态；单集只读 D1 快照；
 *   /api/control/* 控制面，由 Cloudflare Access 按路径保护（应用内不做认证）。
 *
 * 除这两个命名空间外不存在任何 API：旧的 /api/read-podcast/* 不能留作绕过 Access 的别名。
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { makeCloud } from "./helpers/cloud";
import { stateSnapshot } from "./helpers/snapshot";

const PUBLISHED = "11111111-1111-1111-1111-111111111111";
const UNCACHED = "22222222-2222-2222-2222-222222222222";
const RUNNING = "33333333-3333-3333-3333-333333333333";
const CONTENT_PATH = "podcasts/transcripts/20260519_忽左忽右_474.md";
const MARKDOWN = "# 474 孙立天谈康熙废储\n\n正文内容";
const CONCEPTS = [{ term: "康熙", url: "https://zh.wikipedia.org/wiki/康熙帝", wikipedia_title: "康熙帝", summary: "清朝皇帝" }];

// 私有 / 付费播客常把凭据放进 RSS、音频、封面或链接地址；种子数据刻意带上可识别的秘密值，
// 公共面的任何响应里都不允许出现它们。
const SECRET_TOKENS = ["secret-feed-token", "secret-cold-token", "secret-cover-token", "secret-audio-token", "secret-link-token"];
const FEED = "https://feeds.example.com/private/huzuo.rss?token=secret-feed-token";
const COLD_FEED = "https://cold.example.com/u/secret-cold-token/feed.rss";
const COVER = "https://img.example.com/huzuo.jpg?sig=secret-cover-token";
const SEARCH_COVER = "https://is1-ssl.mzstatic.com/image/thumb/cover/600x600bb.jpg";
const STALE_SYNC = "2020-01-01T00:00:00.000Z";

const originalFetch = globalThis.fetch;
let cloud: ReturnType<typeof makeCloud>;
/** Worker 发出的全部出站请求（URL），用来证明公共面没有拉 RSS。 */
let outbound: string[];
/** Worker 通过 ctx.waitUntil 挂起的后台任务数（公共面必须为 0：没有后台刷新）。 */
let backgroundJobs: number;

function seed(): void {
  const db = cloud.d1.raw;
  db.prepare("INSERT INTO subscriptions (id, name, rss_url, image_url, episodes_synced_at) VALUES (1, '忽左忽右', ?, ?, ?)").run(FEED, COVER, STALE_SYNC);
  db.prepare("INSERT INTO subscriptions (id, name, rss_url) VALUES (2, '还没同步', ?)").run(COLD_FEED);
  const insertEpisode = db.prepare(`INSERT INTO episodes (id, subscription_id, podcast_name, title, audio_url, link, published_date, published, source_id, summary)
    VALUES (?, 1, '忽左忽右', ?, ?, ?, ?, ?, ?, '本期简介')`);
  for (const [n, day] of [["474", "19"], ["476", "21"], ["477", "22"]]) {
    const title = { "474": "474 孙立天谈康熙废储", "476": "476 仍在处理", "477": "477 还没生成" }[n]!;
    insertEpisode.run(`1:${n}`, title, `https://cdn.example.com/${n}.mp3?key=secret-audio-token`, `https://example.com/ep/${n}?t=secret-link-token`,
      `2026-05-${day}`, `Tue, ${day} May 2026 00:00:00 GMT`, n);
  }
  const insertTask = db.prepare(`INSERT INTO tasks (id, source_type, podcast_name, episode_title, audio_url, status, progress, message, current_attempt_id, final_content_path, content_commit_sha)
    VALUES (?, 'upload', '忽左忽右', ?, 'r2://uploads/x/a.mp3', ?, ?, '', 'attempt-1', ?, ?)`);
  insertTask.run(PUBLISHED, "474 孙立天谈康熙废储", "success", 100, CONTENT_PATH, "sha-1");
  insertTask.run(UNCACHED, "475 未抽取概念", "success", 100, "podcasts/transcripts/475.md", "sha-2");
  insertTask.run(RUNNING, "476 仍在处理", "refining", 60, null, null);
  const insertArticle = db.prepare("INSERT INTO articles (task_id, title, podcast_name, content_path, commit_sha) VALUES (?, ?, '忽左忽右', ?, ?)");
  insertArticle.run(PUBLISHED, "474 孙立天谈康熙废储", CONTENT_PATH, "sha-1");
  insertArticle.run(UNCACHED, "475 未抽取概念", "podcasts/transcripts/475.md", "sha-2");
  db.prepare("INSERT INTO article_concepts (content_path, commit_sha, concepts_json) VALUES (?, 'sha-1', ?)").run(CONTENT_PATH, JSON.stringify({ concepts: CONCEPTS }));
  db.prepare("INSERT INTO read_state (episode_id) VALUES ('1:474')").run();
  cloud.externals.files.set(CONTENT_PATH, MARKDOWN);
  cloud.externals.files.set("podcasts/transcripts/475.md", "# 475");
}

const snapshot = () => stateSnapshot(cloud);

const call = (path: string, method = "GET", init: RequestInit = {}) =>
  worker.fetch(new Request(`https://app.test${path}`, { method, ...init }), cloud.env, { waitUntil() { backgroundJobs += 1; }, passThroughOnException() {} } as unknown as ExecutionContext);

beforeEach(() => {
  cloud = makeCloud();
  outbound = [];
  backgroundJobs = 0;
  // 公共面允许的外部读：Canonical Manuscript Store、iTunes 检索、封面图。
  // RSS / 模型等其余出站请求会让 FakeExternals 直接抛错。
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    outbound.push(url);
    if (url.startsWith("https://itunes.apple.com/search")) {
      return Response.json({ results: [{ collectionName: "忽左忽右", feedUrl: "https://example.com/rss", artworkUrl600: SEARCH_COVER, artistName: "JustPod" }] });
    }
    if (url === COVER || url === SEARCH_COVER) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    return cloud.fetch(input, init);
  }) as typeof fetch;
  seed();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GET /api/public/* —— 匿名读者可以浏览与阅读已发布稿件", () => {
  it("articles 只返回阅读所需的元数据，不含 Store 路径 / commit / 任务 / 已读状态", async () => {
    const res = await call("/api/public/articles?limit=10");
    expect(res.status).toBe(200);
    const items = (await res.json()) as Array<Record<string, unknown>>;
    expect(items.map(item => item.task_id).sort()).toEqual([PUBLISHED, UNCACHED]);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["created_at", "podcast_name", "task_id", "title", "updated_at"]);
    }
  });

  it("content / download 从 Canonical Manuscript Store 读取已发布正文", async () => {
    const content = await call(`/api/public/articles/${PUBLISHED}/content`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(MARKDOWN);

    const download = await call(`/api/public/articles/${PUBLISHED}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(await download.text()).toBe(MARKDOWN);
  });

  it("concepts 只读缓存：命中返回缓存，未命中返回空列表且不调用模型", async () => {
    expect(await (await call(`/api/public/articles/${PUBLISHED}/concepts`)).json()).toEqual({ concepts: CONCEPTS });
    expect(await (await call(`/api/public/articles/${UNCACHED}/concepts`)).json()).toEqual({ concepts: [] });
    expect(cloud.externals.llmCalls).toBe(0);
  });

  it("未发布（仍在处理）的任务在公共面不可见", async () => {
    for (const suffix of ["content", "download", "concepts"]) {
      const res = await call(`/api/public/articles/${RUNNING}/${suffix}`);
      expect(res.status, suffix).toBe(404);
    }
  });

  it("health 可匿名访问", async () => {
    expect(await (await call("/api/public/health")).json()).toMatchObject({ status: "ok" });
  });
});

describe("GET /api/public/* —— 匿名浏览完整工作区所需的只读数据", () => {
  it("subscriptions 只返回名称、脱敏后的来源域名与是否有封面，不返回 RSS / 封面原始地址", async () => {
    const res = await call("/api/public/subscriptions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { name: "忽左忽右", source_host: "feeds.example.com", has_artwork: true },
      { name: "还没同步", source_host: "cold.example.com", has_artwork: false },
    ]);
  });

  it("旧的整表单集列表接口已删除：只剩分页接口", async () => {
    expect((await call("/api/public/episodes?podcast_name=忽左忽右&limit=0")).status).toBe(404);
    expect((await call("/api/control/episodes?podcast_name=忽左忽右&limit=0")).status).toBe(404);
  });

  it("控制面的分页列表同样不带简介，简介走 /api/control/episodes/summary", async () => {
    const page = (await (await call("/api/control/episodes/page?podcast_name=忽左忽右&limit=100")).json()) as { items: Array<Record<string, unknown>> };
    expect(page.items.length).toBe(3);
    for (const episode of page.items) expect(episode).not.toHaveProperty("summary");
    expect(await (await call(`/api/control/episodes/summary?id=${encodeURIComponent("1:476")}`)).json()).toEqual({ id: "1:476", summary: "本期简介" });
  });

  it("episodes/summary 按 id 只读返回单集简介；未知 id 404，缺 id 400，且不写任何状态", async () => {
    const before = snapshot();
    const res = await call(`/api/public/episodes/summary?id=${encodeURIComponent("1:474")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "1:474", summary: "本期简介" });
    expect((await call("/api/public/episodes/summary?id=1:missing")).status).toBe(404);
    expect((await call("/api/public/episodes/summary")).status).toBe(400);
    expect(snapshot()).toEqual(before);
    expect(outbound).toEqual([]);
  });

  it("任何公开浏览响应里都不出现种子中的 RSS / 音频 / 封面 / 链接凭据", async () => {
    const bodies: string[] = [];
    for (const path of [
      "/api/public/subscriptions",
      "/api/public/episodes/page",
      "/api/public/episodes/page?podcast_name=忽左忽右&limit=100",
      "/api/public/episodes/page?podcast_name=还没同步",
      "/api/public/articles",
      "/api/public/episodes/page?podcast_name=不存在",
      "/api/public/artwork?podcast=还没同步",
      "/api/public/artwork?podcast=不存在",
    ]) {
      bodies.push(await (await call(path)).text());
    }
    const all = bodies.join("\n");
    for (const secret of SECRET_TOKENS) expect(all, secret).not.toContain(secret);
    for (const url of [FEED, COLD_FEED, COVER]) expect(all, url).not.toContain(url);
  });

  it("单集分页只读 D1 快照：快照过期也原样返回，不拉 RSS、不后台刷新、不写库，并忽略 force", async () => {
    for (const path of ["/api/public/episodes/page?podcast_name=忽左忽右&limit=100", "/api/public/episodes/page?podcast_name=忽左忽右&force=true"]) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      const page = (await res.json()) as { items: Array<Record<string, unknown>> };
      expect(page.items.map(ep => ep.title), path).toEqual(["477 还没生成", "476 仍在处理", "474 孙立天谈康熙废储"]);
    }
    expect(outbound).toEqual([]);
    expect(backgroundJobs).toBe(0);
    expect(cloud.d1.raw.prepare("SELECT episodes_synced_at FROM subscriptions WHERE id = 1").get()).toEqual({ episodes_synced_at: STALE_SYNC });
  });

  it("冷订阅（D1 里还没有单集）返回空页，而不是去拉 RSS", async () => {
    const res = await call("/api/public/episodes/page?podcast_name=还没同步");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [], total: 0 });
    expect(outbound).toEqual([]);
  });

  it("单集只带已发布稿件的公开 id，不带任务进度 / 状态 / 失败信息", async () => {
    const page = (await (await call("/api/public/episodes/page?podcast_name=忽左忽右&limit=100")).json()) as { items: Array<Record<string, unknown>> };
    const byTitle = Object.fromEntries(page.items.map(ep => [ep.title, ep]));
    expect(byTitle["474 孙立天谈康熙废储"].article_task_id).toBe(PUBLISHED);
    // 476 有一个正在 refining 的任务：公共面既不暴露它的 id，也不暴露进度或状态。
    expect(byTitle["476 仍在处理"].article_task_id).toBeNull();
    expect(byTitle["477 还没生成"].article_task_id).toBeNull();
    for (const episode of page.items) {
      for (const key of ["status", "progress", "progress_pct", "stage", "message", "task_id", "read", "content_path", "commit_sha"]) {
        expect(episode, key).not.toHaveProperty(key);
      }
    }
    expect(JSON.stringify(page)).not.toContain(RUNNING);
  });

  it("search/podcast 是纯查询的外部检索；空查询不出站，超长查询被拒绝", async () => {
    const res = await call("/api/public/search/podcast?q=忽左忽右");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=");
    expect(await res.json()).toEqual([{ name: "忽左忽右", rss_url: "https://example.com/rss", image: SEARCH_COVER, author: "JustPod" }]);
    expect(outbound.filter(url => url.startsWith("https://itunes.apple.com/"))).toHaveLength(1);

    outbound = [];
    expect(await (await call("/api/public/search/podcast?q=%20")).json()).toEqual([]);
    expect((await call(`/api/public/search/podcast?q=${"x".repeat(101)}`)).status).toBe(400);
    expect(outbound).toEqual([]);
  });

  it("artwork 只代理已订阅节目（按节目名）或检索结果的封面，不是通用图片代理", async () => {
    const cover = await call("/api/public/artwork?podcast=忽左忽右");
    expect(cover.status).toBe(200);
    expect(cover.headers.get("content-type")).toBe("image/jpeg");
    expect(outbound).toEqual([COVER]);
    expect((await call(`/api/public/artwork?url=${encodeURIComponent(SEARCH_COVER)}`)).status).toBe(200);
    outbound = [];
    expect((await call("/api/public/artwork?podcast=还没同步")).status).toBe(404);
    expect((await call("/api/public/artwork?podcast=不存在")).status).toBe(404);
    // 原始订阅封面地址不再按 URL 接受：浏览器本来也拿不到它。
    for (const target of [COVER, "https://example.com/a.jpg", "https://evil.example/mzstatic.com.jpg", "not a url", ""]) {
      expect((await call(`/api/public/artwork?url=${encodeURIComponent(target)}`)).status, target).toBe(404);
    }
    expect(outbound).toEqual([]);
  });
});

describe("公共面严格无副作用", () => {
  it("调用全部公共端点前后，D1 / R2 / Workflow / 外部写入完全不变", async () => {
    const before = snapshot();
    const paths = [
      "/api/public/health",
      "/api/public/articles",
      "/api/public/articles?limit=1&offset=1",
      "/api/public/subscriptions",
      "/api/public/episodes/page",
      "/api/public/episodes/page?podcast_name=忽左忽右&limit=100&force=true",
      "/api/public/episodes/page?podcast_name=还没同步&force=true",
      "/api/public/episodes/page?q=康熙&filter=readable",
      `/api/public/episodes/summary?id=${encodeURIComponent("1:474")}`,
      "/api/public/search/podcast?q=忽左忽右",
      "/api/public/artwork?podcast=忽左忽右",
      `/api/public/artwork?url=${encodeURIComponent(SEARCH_COVER)}`,
      ...[PUBLISHED, UNCACHED, RUNNING].flatMap(id => ["content", "download", "concepts"].map(suffix => `/api/public/articles/${id}/${suffix}`)),
    ];
    for (const path of paths) {
      const res = await call(path);
      expect(res.status, path).toBeLessThan(500);
      await res.arrayBuffer();
    }
    expect(snapshot()).toEqual(before);
    expect(backgroundJobs).toBe(0);
    expect(outbound.filter(url => url === FEED || url === COLD_FEED)).toEqual([]);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("%s /api/public/* → 405，且状态不变", async method => {
    const before = snapshot();
    for (const path of ["/api/public/articles", "/api/public/subscriptions", "/api/public/episodes/page?podcast_name=忽左忽右", `/api/public/articles/${PUBLISHED}/content`, `/api/public/articles/${UNCACHED}/concepts`]) {
      const res = await call(path, method, { headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status, `${method} ${path}`).toBe(405);
    }
    expect(snapshot()).toEqual(before);
  });

  it.each([
    "/api/public/tasks",
    `/api/public/tasks/${PUBLISHED}`,
    "/api/public/tasks/completed-keys",
    "/api/public/settings",
    "/api/public/settings/test",
    "/api/public/episodes/read",
    "/api/public/uploads",
    "/api/public/prompt-templates",
    `/api/public/articles/${PUBLISHED}`,
  ])("GET %s → 404（控制面状态不经公共面暴露）", async path => {
    const before = snapshot();
    expect((await call(path)).status).toBe(404);
    expect(snapshot()).toEqual(before);
  });
});

describe("控制面只存在于 /api/control/*（Cloudflare Access 按路径保护）", () => {
  it.each([
    ["GET", "/api/read-podcast/health"],
    ["GET", "/api/read-podcast/settings"],
    ["PUT", "/api/read-podcast/settings"],
    ["GET", "/api/read-podcast/subscriptions"],
    ["POST", "/api/read-podcast/subscriptions"],
    ["GET", "/api/read-podcast/episodes?podcast_name=忽左忽右"],
    ["GET", "/api/read-podcast/episodes/read"],
    ["PUT", "/api/read-podcast/episodes/read"],
    ["GET", "/api/read-podcast/tasks"],
    ["POST", "/api/read-podcast/tasks"],
    ["POST", "/api/read-podcast/tasks/custom"],
    ["GET", `/api/read-podcast/tasks/${PUBLISHED}/content`],
    ["POST", `/api/read-podcast/tasks/${PUBLISHED}/concepts`],
    ["POST", "/api/read-podcast/uploads/multipart/start?filename=a.mp3&size=1"],
    ["GET", "/api/read-podcast/articles"],
  ])("%s %s → 404（旧前缀不能作为绕过 Access 的别名）", async (method, path) => {
    const before = snapshot();
    const res = await call(path, method, method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(404);
    expect(snapshot()).toEqual(before);
  });

  it("控制面端点在 /api/control/* 下工作", async () => {
    expect((await call("/api/control/tasks")).status).toBe(200);
    expect((await call("/api/control/episodes/read")).status).toBe(200);
    expect((await call(`/api/control/tasks/${PUBLISHED}/content`)).status).toBe(200);
  });

  it("路由源码里的每一个 API 路径都属于 public 或 control 命名空间", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    const literals = [...source.matchAll(/["'`](\/api\/[^"'`]*)/g)].map(match => match[1]);
    const patterns = [...source.matchAll(/\\\/api\\\/([a-z-]+)\\\//g)].map(match => match[1]);
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) expect(literal, literal).toMatch(/^\/api\/(public|control)(\/|$)|^\/api\/$/);
    for (const prefix of patterns) expect(["public", "control"], prefix).toContain(prefix);
  });
});

describe("公共面的边缘缓存：匿名流量不逐次打到上游", () => {
  /** 最小的 caches.default 替身：像 Cache API 一样只保存带 public max-age 的响应。 */
  function installEdgeCache(): Map<string, Response> {
    const store = new Map<string, Response>();
    const cache = {
      async match(request: Request) {
        return store.get(request.url)?.clone();
      },
      async put(request: Request, response: Response) {
        const policy = response.headers.get("cache-control") ?? "";
        if (/private|no-store/.test(policy) || !/max-age=\d+/.test(policy)) return;
        store.set(request.url, new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }));
      },
    };
    (globalThis as { caches?: unknown }).caches = { default: cache };
    return store;
  }

  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
  });

  const storeReads = () => outbound.filter(url => url.includes("/contents/")).length;

  it("正文按 content_path@commit_sha 缓存：重复阅读 / 下载只读一次 Store；浏览器侧仍是 private, no-store", async () => {
    installEdgeCache();
    for (const suffix of ["content", "content", "download"]) {
      const res = await call(`/api/public/articles/${PUBLISHED}/${suffix}`);
      expect(res.status, suffix).toBe(200);
      expect(await res.text()).toBe(MARKDOWN);
      expect(res.headers.get("cache-control"), suffix).toBe("private, no-store");
    }
    expect(storeReads()).toBe(1);
  });

  it("公共阅读是发布快照：按 articles.commit_sha 读取；分支 HEAD 被直接改写也不影响，重新发布才换版本", async () => {
    cloud.externals.revisions.set(`sha-1:${CONTENT_PATH}`, MARKDOWN);
    cloud.externals.files.set(CONTENT_PATH, "# 在 Store 里被直接改写的 HEAD");

    const res = await call(`/api/public/articles/${PUBLISHED}/content`);
    expect(await res.text()).toBe(MARKDOWN);
    expect(outbound.filter(url => url.includes("/contents/")).every(url => url.includes("ref=sha-1"))).toBe(true);

    cloud.d1.raw.prepare("UPDATE articles SET commit_sha = 'sha-2' WHERE task_id = ?").run(PUBLISHED);
    cloud.externals.revisions.set(`sha-2:${CONTENT_PATH}`, "# 重新发布的版本");
    expect(await (await call(`/api/public/articles/${PUBLISHED}/content`)).text()).toBe("# 重新发布的版本");
  });

  it("重新发布（commit_sha 变化）立即换缓存键", async () => {
    installEdgeCache();
    await call(`/api/public/articles/${PUBLISHED}/content`);
    cloud.externals.files.set(CONTENT_PATH, "# 重新发布的正文");
    cloud.d1.raw.prepare("UPDATE articles SET commit_sha = 'sha-new' WHERE task_id = ?").run(PUBLISHED);

    const res = await call(`/api/public/articles/${PUBLISHED}/content`);
    expect(await res.text()).toBe("# 重新发布的正文");
    expect(storeReads()).toBe(2);
  });

  it("Store 里不存在的正文（404）不进缓存", async () => {
    installEdgeCache();
    cloud.externals.files.delete(CONTENT_PATH);
    expect((await call(`/api/public/articles/${PUBLISHED}/content`)).status).toBe(404);
    cloud.externals.files.set(CONTENT_PATH, MARKDOWN);
    const res = await call(`/api/public/articles/${PUBLISHED}/content`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(MARKDOWN);
  });

  it("封面（订阅封面与检索结果封面）重复请求只回源一次", async () => {
    installEdgeCache();
    for (let i = 0; i < 3; i += 1) {
      expect((await call("/api/public/artwork?podcast=忽左忽右")).status).toBe(200);
      expect((await call(`/api/public/artwork?url=${encodeURIComponent(SEARCH_COVER)}`)).status).toBe(200);
    }
    expect(outbound.filter(url => url === COVER)).toHaveLength(1);
    expect(outbound.filter(url => url === SEARCH_COVER)).toHaveLength(1);
  });

  it("封面缓存键不含上游地址（订阅封面地址可能带凭据）", async () => {
    const store = installEdgeCache();
    await call("/api/public/artwork?podcast=忽左忽右");
    expect(store.size).toBe(1);
    for (const key of store.keys()) {
      expect(key).not.toContain("secret-cover-token");
      expect(key).not.toContain(encodeURIComponent(COVER));
    }
  });
});

describe("GET …/episodes/page —— 单集列表服务端分页（不一次加载整个节目单）", () => {
  type Page = { items: Array<Record<string, unknown>>; total: number; counts: Record<string, number>; cache_state: string };
  const page = async (path: string) => {
    const res = await call(path);
    expect(res.status, path).toBe(200);
    return (await res.json()) as Page;
  };

  it("公共面：按时间倒序分页，total 与 counts 来自 D1；只读、无外部请求；列表项不带简介与源地址", async () => {
    const before = snapshot();
    const first = await page("/api/public/episodes/page?limit=2");
    expect(first.items.map(item => item.id)).toEqual(["1:477", "1:476"]);
    expect(first.total).toBe(3);
    expect(first.counts).toEqual({ all: 3, readable: 1, unread: 2, read: 0 });
    expect(Object.keys(first.items[0]).sort()).toEqual(["article_task_id", "duration_seconds", "id", "podcast_name", "published", "title"]);
    const second = await page("/api/public/episodes/page?limit=2&offset=2");
    expect(second.items.map(item => [item.id, item.article_task_id])).toEqual([["1:474", PUBLISHED]]);
    expect(snapshot()).toEqual(before);
    expect(outbound).toEqual([]);
    expect(backgroundJobs).toBe(0);
  });

  it("公共面：标题搜索与筛选在服务端完成；counts 只看节目范围、不受搜索影响", async () => {
    const searched = await page(`/api/public/episodes/page?podcast_name=${encodeURIComponent("忽左忽右")}&q=${encodeURIComponent("康熙")}`);
    expect(searched.items.map(item => item.id)).toEqual(["1:474"]);
    expect(searched.total).toBe(1);
    expect(searched.counts.all).toBe(3);
    expect((await page("/api/public/episodes/page?filter=readable")).items.map(item => item.id)).toEqual(["1:474"]);
    expect((await page("/api/public/episodes/page?filter=unread")).items.map(item => item.id)).toEqual(["1:477", "1:476"]);
    expect((await page("/api/public/episodes/page?filter=read")).total).toBe(0);
    expect((await call("/api/public/episodes/page?filter=bogus")).status).toBe(400);
    expect((await call(`/api/public/episodes/page?podcast_name=${encodeURIComponent("不存在")}`)).status).toBe(404);
  });

  it("控制面：筛选计入已读；未同步的订阅先尝试同步，失败不影响列出快照（cache_state = stale）", async () => {
    const control = await page("/api/control/episodes/page?limit=10");
    expect(control.counts).toEqual({ all: 3, readable: 0, unread: 2, read: 1 });
    expect(control.items).toHaveLength(3);
    expect(control.cache_state).toBe("stale");
    // 从未同步的「还没同步」被同步尝试（假外部环境拒绝了这个请求），过期的「忽左忽右」交给后台刷新
    expect(outbound).toContain(COLD_FEED);
    expect(backgroundJobs).toBe(1);
  });

  it("控制面 force：同步拉取 RSS、入库（命名空间化 id），当页即返回新单集", async () => {
    const fetchBefore = globalThis.fetch;
    const feedXml = `<?xml version="1.0"?><rss><channel><title>忽左忽右</title>
      <item><title>478 新一期</title><guid>guid-478</guid><pubDate>Sat, 23 May 2026 00:00:00 GMT</pubDate>
        <enclosure url="https://cdn.example.com/478.mp3" type="audio/mpeg"/><description>新一期简介</description></item>
    </channel></rss>`;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === FEED ? Promise.resolve(new Response(feedXml, { status: 200 })) : fetchBefore(input, init)) as typeof fetch;

    const result = await page(`/api/control/episodes/page?podcast_name=${encodeURIComponent("忽左忽右")}&force=true`);
    expect(result.cache_state).toBe("complete");
    expect(result.total).toBe(4);
    expect(result.items[0]).toMatchObject({ id: "1:guid-478", title: "478 新一期" });
    expect(result.items[0]).not.toHaveProperty("summary");
    const synced = cloud.d1.raw.prepare("SELECT episodes_synced_at FROM subscriptions WHERE id = 1").get() as { episodes_synced_at: string };
    expect(synced.episodes_synced_at).not.toBe(STALE_SYNC);
    expect(await (await call(`/api/control/episodes/summary?id=${encodeURIComponent("1:guid-478")}`)).json()).toEqual({ id: "1:guid-478", summary: "新一期简介" });
  });

  it("RSS 刷新只写新增 / 变化的单集：同一份 feed 再刷新只更新同步时间", async () => {
    const fetchBefore = globalThis.fetch;
    let title = "478 新一期";
    const feedXml = () => `<?xml version="1.0"?><rss><channel><title>忽左忽右</title>
      <item><title>${title}</title><guid>guid-478</guid><pubDate>Sat, 23 May 2026 00:00:00 GMT</pubDate>
        <enclosure url="https://cdn.example.com/478.mp3" type="audio/mpeg"/></item>
    </channel></rss>`;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === FEED ? Promise.resolve(new Response(feedXml(), { status: 200 })) : fetchBefore(input, init)) as typeof fetch;
    const changes = () => (cloud.d1.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const refresh = () => page(`/api/control/episodes/page?podcast_name=${encodeURIComponent("忽左忽右")}&force=true`);

    await refresh();
    let before = changes();
    await refresh();
    expect(changes() - before).toBe(1); // 只有 subscriptions.episodes_synced_at

    title = "478 新一期（修订）";
    before = changes();
    await refresh();
    expect(changes() - before).toBe(2); // 这一集 + 同步时间
    expect(cloud.d1.raw.prepare("SELECT title FROM episodes WHERE id = '1:guid-478'").get()).toEqual({ title: "478 新一期（修订）" });
  });

  it("控制面：快照新鲜时不刷新 RSS、也不安排后台刷新", async () => {
    cloud.d1.raw.prepare("UPDATE subscriptions SET episodes_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").run();
    const result = await page(`/api/control/episodes/page?podcast_name=${encodeURIComponent("忽左忽右")}`);
    expect(result.cache_state).toBe("complete");
    expect(outbound).toEqual([]);
    expect(backgroundJobs).toBe(0);
  });

  it("控制面：翻页 / 搜索 / 切筛选绝不等待 RSS——从未同步的订阅也只交给后台刷新", async () => {
    // 从未同步的源永远不响应：请求若在等它，这个测试就会超时
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === COLD_FEED ? new Promise<Response>(() => undefined) : fetchBefore(input, init)) as typeof fetch;
    for (const query of ["limit=2&offset=2", "q=474", "filter=unread"]) {
      backgroundJobs = 0;
      const result = await page(`/api/control/episodes/page?${query}`);
      expect(result.cache_state, query).toBe("stale");
      expect(backgroundJobs, query).toBe(1);
    }
  });
});
