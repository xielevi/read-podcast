/**
 * 稿件永久链接与爬虫入口（Public Browse Mode 的页面路由，不是 API）：
 *
 *   /a/<task_id>  已发布稿件页：SPA 外壳 + 服务端注入的 head（全部转义）与 noscript 正文；
 *                 重新生成后的旧 task_id 301 到当前稿件，未发布 / 未知一律 404，不泄露任务状态；
 *   /sitemap.xml  首页 + 全部已发布稿件页，lastmod = articles.updated_at；
 *   /feed.xml     最近稿件的 Atom feed，条目正文是导读（brief），不读 Store；
 *   /robots.txt   允许 / 与 /a/，禁止 /manage 与 /api/control/。
 *
 * 与 /api/public/* 同一组只读保证：只接受 GET / HEAD，不写任何状态，不暴露 Store 路径 / commit。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { articleDescription } from "../src/article_page";
import { createNodeEnv } from "../src/platform/node";
import { makeCloud } from "./helpers/cloud";
import { stateSnapshot } from "./helpers/snapshot";

const CURRENT = "aaaaaaaa-1111-1111-1111-111111111111";
const REGENERATED = "bbbbbbbb-2222-2222-2222-222222222222";
const RUNNING = "cccccccc-3333-3333-3333-333333333333";
const UPLOAD = "dddddddd-4444-4444-4444-444444444444";
const UNKNOWN = "eeeeeeee-5555-5555-5555-555555555555";
const REGENERATING = "ffffffff-6666-6666-6666-666666666666";
const CONTENT_PATH = "podcasts/transcripts/20260519_忽左忽右_474.md";
const COMMIT = "sha-current-commit";
const COVER = "https://img.example.com/huzuo.jpg?sig=secret-cover-token";
const FEED = "https://feeds.example.com/private/huzuo.rss?token=secret-feed-token";
const TITLE = `474 "康熙" <script>alert(1)</script> & 废储`;
const MARKDOWN = [
  "---",
  "title: 474",
  "---",
  "",
  "## 📌 节目大纲与时间线",
  "",
  "- 00:00 开场",
  "- 12:30 废储",
  "",
  "## 正文",
  "",
  "**主持人**：今天我们聊聊<b>康熙</b>两次废黜太子的前因后果，以及背后的权力结构与父子关系。",
  "",
  "第二段内容。",
].join("\n");

const originalFetch = globalThis.fetch;
const INDEX_HTML = readFileSync(resolve(__dirname, "../public/index.html"), "utf8");
let cloud: ReturnType<typeof makeCloud>;

function seed(): void {
  const db = cloud.d1.raw;
  db.prepare("INSERT INTO subscriptions (id, name, rss_url, image_url) VALUES (1, '忽左忽右', ?, ?)").run(FEED, COVER);
  db.prepare(`INSERT INTO episodes (id, subscription_id, podcast_name, title, audio_url, published_date, source_id)
    VALUES ('1:474', 1, '忽左忽右', '474', 'https://cdn.example.com/474.mp3?key=secret-audio-token', '2026-05-19', '474')`).run();
  const insertTask = db.prepare(`INSERT INTO tasks (id, episode_id, source_type, podcast_name, episode_title, audio_url, status, progress, message, current_attempt_id, final_content_path, content_commit_sha)
    VALUES (?, ?, ?, '忽左忽右', ?, 'r2://uploads/x/a.mp3', ?, ?, '', 'attempt-1', ?, ?)`);
  // 同一单集生成过两次：articles 只指向最新任务，旧任务 REGENERATED 仍在 tasks 表里。
  insertTask.run(REGENERATED, "1:474", "rss", TITLE, "success", 100, CONTENT_PATH, "sha-old-commit");
  insertTask.run(CURRENT, "1:474", "rss", TITLE, "success", 100, CONTENT_PATH, COMMIT);
  insertTask.run(RUNNING, null, "upload", "476 仍在处理", "refining", 60, null, null);
  // 同一单集正在重新生成（尚未发布）：它的 id 不能 301，否则泄露未发布任务的存在。
  insertTask.run(REGENERATING, "1:474", "rss", TITLE, "refining", 60, null, null);
  insertTask.run(UPLOAD, null, "upload", "导入音频", "success", 100, "podcasts/transcripts/upload.md", "sha-upload");
  db.prepare(`INSERT INTO articles (task_id, episode_id, title, podcast_name, content_path, commit_sha, created_at, updated_at)
    VALUES (?, '1:474', ?, '忽左忽右', ?, ?, '2026-05-19T00:00:00.000Z', '2026-05-20T08:00:00.000Z')`).run(CURRENT, TITLE, CONTENT_PATH, COMMIT);
  db.prepare(`INSERT INTO articles (task_id, title, podcast_name, content_path, commit_sha, created_at, updated_at)
    VALUES (?, '导入音频', '', 'podcasts/transcripts/upload.md', 'sha-upload', '2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z')`).run(UPLOAD);
  cloud.externals.files.set(CONTENT_PATH, MARKDOWN);
  cloud.externals.files.set("podcasts/transcripts/upload.md", "# 导入音频\n\n这是一段导入音频整理出来的正文，长度足够作为描述。");
}

const call = (path: string, method = "GET") =>
  worker.fetch(new Request(`https://app.test${path}`, { method }), cloud.env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);

beforeEach(() => {
  cloud = makeCloud();
  cloud.env.assets = { fetch: async () => new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }) };
  globalThis.fetch = cloud.fetch;
  seed();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function metaContent(html: string, attr: "name" | "property", key: string): string | null {
  const match = html.match(new RegExp(`<meta ${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" content="([^"]*)">`));
  return match ? match[1] : null;
}

describe("GET /a/<task_id> —— 已发布稿件的永久链接", () => {
  it("返回 SPA 外壳，head 注入转义后的标题、描述、canonical 与 Open Graph / Twitter card", async () => {
    const res = await call(`/a/${CURRENT}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();

    const escapedTitle = "474 &quot;康熙&quot; &lt;script&gt;alert(1)&lt;/script&gt; &amp; 废储";
    expect(html).toContain(`<title>${escapedTitle} · 忽左忽右</title>`);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain(`<link rel="canonical" href="https://app.test/a/${CURRENT}">`);
    expect(metaContent(html, "property", "og:type")).toBe("article");
    expect(metaContent(html, "property", "og:title")).toBe(escapedTitle);
    expect(metaContent(html, "property", "og:url")).toBe(`https://app.test/a/${CURRENT}`);
    expect(metaContent(html, "property", "og:site_name")).toBe("Read Podcast");
    expect(metaContent(html, "property", "og:image")).toBe(`https://app.test/api/public/artwork?podcast=${encodeURIComponent("忽左忽右")}`);
    expect(metaContent(html, "name", "twitter:card")).toBe("summary");
    expect(metaContent(html, "name", "read-podcast:article")).toBe(CURRENT);

    // 描述取大纲之后的第一段正文，去掉 Markdown 与 HTML 标记后转义。
    const description = metaContent(html, "name", "description")!;
    expect(description).toContain("主持人：今天我们聊聊&lt;b&gt;康熙&lt;/b&gt;两次废黜太子");
    expect(description).not.toContain("00:00");
    expect(metaContent(html, "property", "og:description")).toBe(description);

    // 爬虫可见的正文：noscript 中的转义纯文本，SPA 的脚本与样式仍然在。
    const noscript = html.match(/<noscript>([\s\S]*?)<\/noscript>/)![1];
    expect(noscript).toContain(`<h1>${escapedTitle}</h1>`);
    expect(noscript).toContain("第二段内容。");
    expect(noscript).not.toContain("<b>");
    expect(html).toContain("/app.js");
    expect(html).toContain('id="manuscript-reader"');
  });

  it("没有订阅封面的稿件用站点预览图（大图卡片）；页面不暴露 Store 路径、commit、任务状态或源地址凭据", async () => {
    const upload = await (await call(`/a/${UPLOAD}`)).text();
    expect(upload).toContain("<title>导入音频</title>");
    expect(metaContent(upload, "property", "og:image")).toBe("https://app.test/og.png");
    expect(metaContent(upload, "name", "twitter:image")).toBe("https://app.test/og.png");
    expect(metaContent(upload, "name", "twitter:card")).toBe("summary_large_image");

    const current = await (await call(`/a/${CURRENT}`)).text();
    for (const html of [upload, current]) {
      for (const secret of [CONTENT_PATH, "podcasts/transcripts", COMMIT, "sha-upload", "secret-cover-token", "secret-feed-token", "secret-audio-token", "img.example.com", "attempt-1"]) {
        expect(html, secret).not.toContain(secret);
      }
    }
  });

  it("文档语言跟随稿件内容：中文稿件 zh-CN / zh_CN，英文稿件 en / en_US", async () => {
    const zh = await (await call(`/a/${CURRENT}`)).text();
    expect(zh).toMatch(/<html lang="zh-CN">/);
    expect(metaContent(zh, "property", "og:locale")).toBe("zh_CN");

    const english = "99999999-7777-7777-7777-777777777777";
    cloud.d1.raw.prepare(`INSERT INTO tasks (id, source_type, podcast_name, episode_title, audio_url, status, progress, message, current_attempt_id, final_content_path, content_commit_sha)
      VALUES (?, 'upload', 'Example Show', 'How Markets Learn', 'r2://uploads/y/a.mp3', 'success', 100, '', 'attempt-en', 'podcasts/transcripts/en.md', 'sha-en')`).run(english);
    cloud.d1.raw.prepare(`INSERT INTO articles (task_id, title, podcast_name, content_path, commit_sha, created_at, updated_at)
      VALUES (?, 'How Markets Learn', 'Example Show', 'podcasts/transcripts/en.md', 'sha-en', '2026-05-03T00:00:00.000Z', '2026-05-03T00:00:00.000Z')`).run(english);
    cloud.externals.files.set("podcasts/transcripts/en.md",
      "## 01 | Opening\n\n**Host**: Today we look at how prices carry information, with a short aside on 孔子 and the 2008 crisis.");
    const en = await (await call(`/a/${english}`)).text();
    expect(en).toMatch(/<html lang="en">/);
    expect(en.match(/<html[\s>]/g)).toHaveLength(1);
    expect(metaContent(en, "property", "og:locale")).toBe("en_US");
  });

  it("重新生成后旧 task_id 301 到同一单集的当前稿件", async () => {
    const res = await call(`/a/${REGENERATED}`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://app.test/a/${CURRENT}`);
  });

  it("未发布 / 未知 / 非法 id 一律 404 页面（noindex），不区分任务状态", async () => {
    const bodies: string[] = [];
    for (const path of [`/a/${RUNNING}`, `/a/${REGENERATING}`, `/a/${UNKNOWN}`, "/a/not-a-task!", "/a/", "/a"]) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      const html = await res.text();
      expect(html, path).toContain('<meta name="robots" content="noindex">');
      expect(html, path).not.toContain("read-podcast:article");
      bodies.push(html.replace(/\/a\/[^"]*/g, ""));
    }
    // 处理中的任务与根本不存在的 id 得到完全相同的页面。
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).not.toContain("476 仍在处理");
    expect(bodies[0]).not.toContain("refining");
  });

  it("只接受 GET / HEAD；读取不写任何状态", async () => {
    const before = stateSnapshot(cloud);
    const head = await call(`/a/${CURRENT}`, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "DELETE"]) {
      for (const path of [`/a/${CURRENT}`, "/sitemap.xml", "/feed.xml", "/robots.txt"]) {
        expect((await call(path, method)).status, `${method} ${path}`).toBe(405);
      }
    }
    await call(`/a/${CURRENT}`);
    await call(`/a/${REGENERATED}`);
    await call(`/a/${RUNNING}`);
    await call("/sitemap.xml");
    await call("/feed.xml");
    expect(stateSnapshot(cloud)).toEqual(before);
  });
});

describe("GET /feed.xml", () => {
  const BRIEF = JSON.stringify({
    version: 1,
    tldr: "康熙两次废储<背后>是皇权与储君的结构性冲突。",
    key_points: ["要点一", "要点二", "要点三"],
    quotes: [{ speaker: "主持人", text: "今天我们聊聊康熙" }],
    audience: "关心清史的读者",
    sections: [],
    reading_minutes: 12,
  });

  it("按发布时间倒序列出已发布稿件，正文是转义后的导读，链接指向稿件页", async () => {
    cloud.d1.raw.prepare("UPDATE articles SET brief = ? WHERE task_id = ?").run(BRIEF, CURRENT);
    const fetched: string[] = [];
    const inner = cloud.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return inner(input, init);
    }) as typeof fetch;
    const res = await call("/feed.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    const xml = await res.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('<link rel="self" type="application/atom+xml" href="https://app.test/feed.xml"/>');
    expect(xml.indexOf(`/a/${CURRENT}`)).toBeLessThan(xml.indexOf(`/a/${UPLOAD}`));
    expect(xml.match(/<entry>/g)).toHaveLength(2);
    expect(xml).toContain("<updated>2026-05-20T08:00:00.000Z</updated>");
    // 标题与导读都经过转义：原始 <script> / <背后> 不会出现在 XML 里。
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("<背后>");
    expect(xml).toContain("&lt;背后&gt;");
    expect(xml).toContain("要点二");
    expect(xml).toContain("阅读全文（约 12 分钟）");
    for (const id of [REGENERATED, RUNNING]) expect(xml).not.toContain(id);
    for (const secret of [CONTENT_PATH, COMMIT, "secret-feed-token", "secret-cover-token"]) expect(xml).not.toContain(secret);
    // feed 只读 D1，不读 Store。
    expect(fetched).toEqual([]);
  });

  it("稿件页的 meta description 优先使用导读的 tldr", async () => {
    cloud.d1.raw.prepare("UPDATE articles SET brief = ? WHERE task_id = ?").run(BRIEF, CURRENT);
    const html = await (await call(`/a/${CURRENT}`)).text();
    expect(html).toContain('<meta name="description" content="康熙两次废储&lt;背后&gt;是皇权与储君的结构性冲突。">');
  });

  it("没有导读的旧稿件只给标题、节目名与链接", async () => {
    const xml = await (await call("/feed.xml")).text();
    expect(xml).toContain("<summary>忽左忽右</summary>");
    expect(xml).toContain("<summary>Read Podcast</summary>");
    expect(xml).not.toContain("要点");
  });
});

describe("GET /sitemap.xml 与 /robots.txt", () => {
  it("sitemap 列出首页与全部已发布稿件页（lastmod = articles.updated_at），不含未发布或旧任务", async () => {
    const res = await call("/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain("<loc>https://app.test/</loc>");
    expect(xml).toContain(`<url><loc>https://app.test/a/${CURRENT}</loc><lastmod>2026-05-20T08:00:00.000Z</lastmod></url>`);
    expect(xml).toContain(`<url><loc>https://app.test/a/${UPLOAD}</loc><lastmod>2026-05-02T00:00:00.000Z</lastmod></url>`);
    for (const id of [REGENERATED, RUNNING]) expect(xml).not.toContain(id);
    expect(xml.match(/<url>/g)).toHaveLength(3);
  });

  it("robots 允许 / 与 /a/，禁止控制面，并指向 sitemap", async () => {
    const res = await call("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    for (const line of ["User-agent: *", "Allow: /", "Allow: /a/", "Disallow: /manage", "Disallow: /api/control/", "Sitemap: https://app.test/sitemap.xml"]) {
      expect(text).toContain(line);
    }
  });

  it("页面路由不受控制面认证影响，也不新增 API 前缀", async () => {
    cloud.env.CONTROL_AUTH_MODE = undefined;
    expect((await call(`/a/${CURRENT}`)).status).toBe(200);
    expect((await call("/manage")).status).toBe(401);
    expect((await call("/api/a/x")).status).toBe(404);
  });
});

describe("articleDescription", () => {
  it("跳过 frontmatter 与开头大纲，取第一段有意义的正文并截断到约 160 字", () => {
    const long = "这是很长的一段正文。".repeat(40);
    const description = articleDescription({ markdown: `# 标题\n\n## Outline & Timeline\n\n- 00:00 a\n\n## Body\n\n00:00\n\n${long}` });
    expect(Array.from(description)).toHaveLength(160);
    expect(description.endsWith("…")).toBe(true);
    expect(description.startsWith("这是很长的一段正文")).toBe(true);
  });

  it("提供 brief 时优先使用", () => {
    expect(articleDescription({ markdown: "正文正文正文正文正文正文", brief: "  一句话**摘要**  " })).toBe("一句话摘要");
  });
});

describe("Node 平台", () => {
  it("同一 Worker 在本地运行时（SQLite + 本地稿件目录 + public/ 静态资源）提供 /a/<task_id>", async () => {
    const dir = resolve(process.cwd(), "data/test-article-page");
    const runtime = createNodeEnv({
      databasePath: ":memory:",
      storageDir: resolve(dir, "storage"),
      manuscriptDir: resolve(dir, "manuscripts"),
      publicDir: resolve(__dirname, "../public"),
      env: { APP_ENV: "test" },
    });
    const published = await runtime.env.manuscripts.publish({ writingFilename: "20260927_测试播客_本地", title: "本地稿件", markdown: "# 本地稿件\n\n本地部署也能通过永久链接阅读这篇稿件。" });
    const taskId = "12345678-1234-1234-1234-123456789abf";
    runtime.dbSync.prepare("INSERT INTO tasks (id, source_type, episode_title, status, progress, message) VALUES (?, 'upload', '本地稿件', 'success', 100, '')").run(taskId);
    runtime.dbSync.prepare("INSERT INTO articles (task_id, title, podcast_name, content_path, commit_sha) VALUES (?, '本地稿件', '测试播客', ?, ?)")
      .run(taskId, published.path, published.version);

    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request(`http://localhost:3000/a/${taskId}`), runtime.env, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>本地稿件 · 测试播客</title>");
    expect(html).toContain(`<link rel="canonical" href="http://localhost:3000/a/${taskId}">`);
    expect(html).toContain("本地部署也能通过永久链接阅读这篇稿件。");
    expect(html).toContain('id="manuscript-reader"');
    expect(html).not.toContain(published.version);

    const sitemap = await (await worker.fetch(new Request("http://localhost:3000/sitemap.xml"), runtime.env, ctx)).text();
    expect(sitemap).toContain(`http://localhost:3000/a/${taskId}`);
    runtime.close();
  });
});
