/**
 * 一个工作区，两种能力 —— 在真实页面上验证（jsdom 加载 public/index.html + public/app.js，
 * 浏览器的 fetch 直接路由到真实 Worker 与 makeCloud 的 D1 / R2 / Workflow 假件）：
 *
 *   /        Public Browse Mode：完整工作区可浏览；只访问 /api/public/*、只发 GET、不改任何状态；
 *            有副作用的控件保持可见，点击时进入受 Access 保护的 /manage（带 intent），而不是调用写接口；
 *   /manage  Authenticated Control Mode：同一套界面，原有操作照常走 /api/control/*。
 */
import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
// @ts-expect-error 无类型声明
import { assembleFrontend } from "../scripts/build_frontend.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { makeCloud } from "./helpers/cloud";
import { stateSnapshot } from "./helpers/snapshot";

const HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf-8");
const BUNDLE: string = assembleFrontend();

const PUBLISHED = "11111111-1111-1111-1111-111111111111";
const CONTENT_PATH = "podcasts/transcripts/474.md";
const PODCAST = "忽左忽右";
const PUBLISHED_TITLE = "474 孙立天谈康熙废储";
const PENDING_TITLE = "477 还没生成";
const SEARCH_COVER = "https://is1-ssl.mzstatic.com/image/thumb/cover/600x600bb.jpg";

type PageWindow = Window & typeof globalThis & { enterControlMode: (url: string) => void };
interface Sent { method: string; path: string }
interface Page {
  window: PageWindow;
  document: Document;
  sent: Sent[];
  navigations: string[];
  byId(id: string): HTMLElement;
  all(selector: string): HTMLElement[];
  text(selector: string): string;
  until(check: () => unknown): Promise<void>;
  close(): void;
}

const originalFetch = globalThis.fetch;
let cloud: ReturnType<typeof makeCloud>;
let pages: Page[] = [];

function seed(): void {
  const db = cloud.d1.raw;
  // 快照已过期：控制面的 GET /episodes 会触发后台刷新，公共面必须原样返回。
  // 源地址里带着凭据（私有 / 付费播客的常见形态）：公开浏览的页面上不允许出现。
  db.prepare("INSERT INTO subscriptions (id, name, rss_url, image_url, episodes_synced_at) VALUES (1, ?, 'https://feeds.example.com/p.rss?token=secret-feed-token', 'https://img.example.com/c.jpg?sig=secret-cover-token', '2020-01-01T00:00:00.000Z')").run(PODCAST);
  const insertEpisode = db.prepare(`INSERT INTO episodes (id, subscription_id, podcast_name, title, audio_url, published_date, published, source_id, summary)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, '本期简介')`);
  insertEpisode.run("1:474", PODCAST, PUBLISHED_TITLE, "https://cdn.example.com/474.mp3?key=secret-audio-token", "2026-05-19", "Tue, 19 May 2026 00:00:00 GMT", "474");
  insertEpisode.run("1:477", PODCAST, PENDING_TITLE, "https://cdn.example.com/477.mp3?key=secret-audio-token", "2026-05-22", "Fri, 22 May 2026 00:00:00 GMT", "477");
  db.prepare(`INSERT INTO tasks (id, episode_id, source_type, podcast_name, episode_title, audio_url, status, progress, message, current_attempt_id, final_content_path, content_commit_sha)
    VALUES (?, '1:474', 'rss', ?, ?, 'https://example.com/474.mp3', 'success', 100, '', 'attempt-1', ?, 'sha-1')`).run(PUBLISHED, PODCAST, PUBLISHED_TITLE, CONTENT_PATH);
  db.prepare("INSERT INTO articles (task_id, episode_id, title, podcast_name, content_path, commit_sha) VALUES (?, '1:474', ?, ?, ?, 'sha-1')")
    .run(PUBLISHED, PUBLISHED_TITLE, PODCAST, CONTENT_PATH);
  db.prepare("INSERT INTO article_concepts (content_path, commit_sha, concepts_json) VALUES (?, 'sha-1', ?)")
    .run(CONTENT_PATH, JSON.stringify({ concepts: [{ term: "康熙", url: "https://zh.wikipedia.org/wiki/康熙帝", wikipedia_title: "康熙帝", summary: "清朝皇帝" }] }));
  cloud.externals.files.set(CONTENT_PATH, `### 📌 节目大纲与时间线\n- **00:00** 开场\n- **10:00** 议政王大臣会议\n\n---\n\n## 01 | 康熙废储始末\n\n康熙年间的故事。`);
}

/** 在 jsdom 里打开页面：页面自身的内联脚本照常运行，随后注入 app.js（等价于 index.html 里按 base path 加载）。 */
function openPage(path: string): Page {
  const sent: Sent[] = [];
  const navigations: string[] = [];
  const pending = new Set<Promise<unknown>>();
  const virtualConsole = new VirtualConsole(); // 吞掉 jsdom 的「未实现 scrollTo / 导航」等噪声
  const dom = new JSDOM(HTML, {
    url: `https://app.test${path}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window.navigator, "language", { value: "zh-CN", configurable: true });
      (window as unknown as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.href);
        sent.push({ method: (init?.method ?? "GET").toUpperCase(), path: decodeURIComponent(url.pathname + url.search) });
        const ctx = { waitUntil(promise: Promise<unknown>) { pending.add(promise); }, passThroughOnException() {} } as unknown as ExecutionContext;
        const response = worker.fetch(new Request(url, init), cloud.env, ctx);
        pending.add(response);
        return response;
      }) as typeof fetch;
    },
  });
  const window = dom.window as unknown as PageWindow;
  const script = window.document.createElement("script");
  script.textContent = BUNDLE;
  window.document.body.appendChild(script);
  // requireControl 通过这个全局函数离开页面；jsdom 不实现跨文档导航，所以记录目标 URL。
  window.enterControlMode = url => { navigations.push(url); };
  const page: Page = {
    window,
    document: window.document,
    sent,
    navigations,
    byId: (id: string) => window.document.getElementById(id) as HTMLElement,
    all: (selector: string) => [...window.document.querySelectorAll<HTMLElement>(selector)],
    text: (selector: string) => window.document.querySelector(selector)?.textContent ?? "",
    /** 等待一个条件成立，同时让页面发出的请求（以及 Worker 的后台任务）全部落定。 */
    async until(check: () => unknown) {
      await vi.waitFor(() => { if (!check()) throw new Error("condition not met"); }, { timeout: 3000, interval: 10 });
      await Promise.allSettled([...pending]);
    },
    close() { window.close(); },
  };
  pages.push(page);
  return page;
}

function click(element: Element | null | undefined): void {
  if (!element) throw new Error("element not found");
  element.dispatchEvent(new (element.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true, cancelable: true }));
}

function episodeRow(page: Page, title: string): HTMLElement {
  const row = page.all(".episode-item").find(item => item.dataset.episodeTitle === title);
  if (!row) throw new Error(`episode row not found: ${title}`);
  return row;
}

async function openAnonymousWorkspace(): Promise<Page> {
  const page = openPage("/");
  await page.until(() => page.all(".episode-item[data-episode-title]").length === 2);
  return page;
}

beforeEach(() => {
  cloud = makeCloud();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://itunes.apple.com/search")) {
      return Response.json({ results: [{ collectionName: "新节目", feedUrl: "https://example.com/new.rss", artworkUrl600: SEARCH_COVER, artistName: "作者" }] });
    }
    return cloud.fetch(input, init);
  }) as typeof fetch;
  seed();
});

afterEach(() => {
  for (const page of pages) page.close();
  pages = [];
  globalThis.fetch = originalFetch;
});

describe("Public Browse Mode：匿名用户看到完整工作区", () => {
  it("进入订阅工作区（而不是只有稿件的精简界面），订阅与单集来自公共只读接口", async () => {
    const page = await openAnonymousWorkspace();
    expect(page.document.documentElement.dataset.surface).toBe("public");
    expect(page.document.body.dataset.mode).toBe("podcast");
    expect(page.byId("podcast-panel").classList.contains("is-active")).toBe(true);
    expect(page.all(".nav-tab").map(tab => tab.textContent?.trim())).toEqual(["订阅", "导入", "稿件"]);
    expect(page.all(".mobile-nav [data-mode]").map(button => button.textContent)).toEqual(["订阅", "导入", "稿件"]);
    expect(page.all(".podcast-item .pod-name").map(node => node.textContent)).toEqual(["全部订阅", PODCAST]);
    expect(page.sent).toContainEqual({ method: "GET", path: "/api/public/subscriptions" });
    // 单集列表由服务端分页：只取当前一页，从不拉整个节目单
    expect(page.sent.some(req => req.path.startsWith("/api/public/episodes/page?limit=10&offset=0"))).toBe(true);
    expect(page.sent.some(req => /\/episodes\?.*limit=0/.test(req.path))).toBe(false);
  });

  it("公开态不显示删除按钮，主题切换是显式选择而非循环", async () => {
    const page = await openAnonymousWorkspace();
    expect(page.all(".pod-delete-btn")).toEqual([]);
    click(page.byId("public-theme-btn"));
    expect(page.byId("public-theme-menu").hasAttribute("open")).toBe(true);
    const dark = page.document.querySelector('[data-public-theme="dark"]') as HTMLButtonElement;
    click(dark);
    expect(page.document.documentElement.dataset.appTheme).toBe("dark");
    expect(page.window.localStorage.getItem("app_theme")).toBe("dark");
    expect(page.byId("public-theme-menu").hasAttribute("open")).toBe(false);
  });

  it("已发布单集直接提供阅读和下载，公开态没有重新生成菜单", async () => {
    const page = await openAnonymousWorkspace();
    const row = episodeRow(page, PUBLISHED_TITLE);
    expect([...row.querySelectorAll(".episode-action")].map(el => el.textContent?.trim())).toEqual(["阅读", "下载"]);
    expect(row.querySelector(".episode-download-action")?.getAttribute("href")).toBe(`/api/public/articles/${PUBLISHED}/download`);
    expect(row.querySelector(".rerun")).toBeNull();
    click(row);
    expect([...page.byId("inspector-actions").querySelectorAll(".episode-action")].map(el => el.textContent?.trim())).toEqual(["阅读", "下载 Markdown"]);
  });

  it("订阅来源只显示脱敏后的域名；页面里没有任何源地址凭据", async () => {
    const page = await openAnonymousWorkspace();
    click(episodeRow(page, PUBLISHED_TITLE));
    expect(page.text(`.podcast-item[data-name="${PODCAST}"] .pod-meta`)).toBe("feeds.example.com");
    const html = page.document.documentElement.outerHTML;
    for (const secret of ["secret-feed-token", "secret-cover-token", "secret-audio-token"]) expect(html, secret).not.toContain(secret);
  });

  it("单集只区分「可阅读 / 未生成」，不显示任务进度或已读状态", async () => {
    const page = await openAnonymousWorkspace();
    const published = episodeRow(page, PUBLISHED_TITLE);
    const pending = episodeRow(page, PENDING_TITLE);
    expect(published.querySelector(".status-tag")?.textContent).toBe("可阅读");
    expect(published.querySelector(".episode-action")?.textContent).toBe("阅读");
    expect(pending.querySelector(".status-tag")?.textContent).toBe("未生成");
    expect(pending.querySelector(".episode-action")?.textContent).toBe("生成稿件");
    const listText = page.text("#episode-list");
    for (const ownerState of ["待读", "已读", "生成中", "失败"]) expect(listText).not.toContain(ownerState);
    // 已读过滤、任务队列、阅读进度都是主人状态，只在控制模式渲染。
    for (const selector of ["#filter-read", "#task-panel-btn", "#reader-progress-range", "#reader-read-toggle"]) {
      expect(page.document.querySelector(selector)?.closest(".owner-state-only"), selector).not.toBeNull();
    }
  });

  it("可以选择节目、搜索单集、打开单集介绍", async () => {
    const page = await openAnonymousWorkspace();
    click(page.document.querySelector(`.podcast-item[data-name="${PODCAST}"] .pod-select-btn`));
    await page.until(() => page.byId("center-title").textContent === PODCAST && page.all(".episode-item[data-episode-title]").length === 2);

    const search = page.byId("episode-search") as HTMLInputElement;
    search.value = "康熙";
    search.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    // 搜索在服务端完成（防抖后带 q= 取第一页）
    await page.until(() => page.all(".episode-item[data-episode-title]").length === 1);
    expect(page.all(".episode-item[data-episode-title]").map(row => row.dataset.episodeTitle)).toEqual([PUBLISHED_TITLE]);
    expect(page.sent.some(req => req.path.includes("q=康熙"))).toBe(true);

    click(episodeRow(page, PUBLISHED_TITLE));
    expect(page.byId("inspector-title").textContent).toBe(PUBLISHED_TITLE);
    // 简介不在列表数据里：点开单集时按需经公共接口读取
    await page.until(() => page.byId("inspector-summary").textContent === "本期简介");
    expect(page.sent.filter(req => req.path.startsWith("/api/public/episodes/summary?id="))).toHaveLength(1);
    expect(page.byId("inspector-meta").textContent).toContain("可阅读");
  });

  it("阅读已发布稿件：正文剔除开篇大纲、缓存概念、工具栏里直接可见的下载走公共接口", async () => {
    const page = await openAnonymousWorkspace();
    click(episodeRow(page, PUBLISHED_TITLE).querySelector(".episode-action"));
    await page.until(() => page.byId("manuscript-body").textContent?.includes("康熙年间的故事") && page.all(".concept-link").length === 1);

    // 1. 阅读呈现层：开篇大纲/时间线已被剔除，正文始于真实章节
    const bodyText = page.byId("manuscript-body").textContent || "";
    expect(bodyText).toContain("01 | 康熙废储始末");
    expect(bodyText).not.toContain("节目大纲与时间线");
    expect(bodyText).not.toContain("议政王大臣会议");

    // 2. 左侧目录 TOC：只包含真实章节，大纲标题不作为目录项
    const tocItems = page.all("#reader-toc .toc-item").map(item => item.textContent?.trim());
    expect(tocItems).toEqual(["01 | 康熙废储始末"]);

    // 3. 下载操作：直接位于工具栏；公开态没有主人已读控制。
    const download = page.byId("reader-download") as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe(`/api/public/articles/${PUBLISHED}/download`);
    expect(download.textContent).toContain("下载 Markdown");
    expect(download.closest("details")).toBeNull();
    expect(page.byId("reader-read-toggle").hidden).toBe(true);

    expect(page.sent).toContainEqual({ method: "GET", path: `/api/public/articles/${PUBLISHED}/content` });
    expect(page.sent).toContainEqual({ method: "GET", path: `/api/public/articles/${PUBLISHED}/concepts` });

    // 4. 下载负载：下载端点返回的原始内容不受影响，完整保留大纲与时间线
    const downloadRes = await worker.fetch(new Request(`https://app.test/api/public/articles/${PUBLISHED}/download`), cloud.env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(downloadRes.status).toBe(200);
    const downloaded = await downloadRes.text();
    expect(downloaded).toContain("### 📌 节目大纲与时间线");
    expect(downloaded).toContain("议政王大臣会议");

    // 阅读不留任何读者状态：不读写已读，也不保存阅读位置。
    const body = page.byId("manuscript-body");
    body.scrollTop = 40;
    body.dispatchEvent(new page.window.Event("scroll"));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(Object.keys(page.window.localStorage).filter(key => key.startsWith("scroll_pos_"))).toEqual([]);
    expect(page.sent.some(req => req.path.includes("/episodes/read"))).toBe(false);
  });

  it("稿件库可浏览、搜索和下载", async () => {
    const page = await openAnonymousWorkspace();
    click(page.byId("tab-library"));
    await page.until(() => page.all(".library-item").length === 1);
    expect(page.sent).toContainEqual({ method: "GET", path: "/api/public/articles?limit=200" });
    expect(page.document.querySelector(".library-item .download-btn")?.getAttribute("href")).toBe(`/api/public/articles/${PUBLISHED}/download`);

    const search = page.byId("library-search") as HTMLInputElement;
    search.value = "不存在的稿件";
    search.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    expect(page.text("#library-list")).toContain("没有找到匹配的稿件");
  });

  it("可以打开「添加订阅」搜索新节目并查看结果", async () => {
    const page = await openAnonymousWorkspace();
    click(page.byId("add-podcast-btn"));
    const input = page.byId("drawer-search") as HTMLInputElement;
    input.value = "新节目";
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    await page.until(() => page.all(".search-result").length === 1);
    expect(page.text(".search-result .result-name")).toBe("新节目");
    expect(page.sent).toContainEqual({ method: "GET", path: "/api/public/search/podcast?q=新节目" });
  });

  it("整个浏览过程只发 GET /api/public/*，且 D1 / R2 / Workflow / 外部写入完全不变", async () => {
    const before = stateSnapshot(cloud);
    const page = await openAnonymousWorkspace();
    click(page.document.querySelector(`.podcast-item[data-name="${PODCAST}"] .pod-select-btn`));
    await page.until(() => page.byId("center-title").textContent === PODCAST && page.all(".episode-item[data-episode-title]").length === 2);
    click(episodeRow(page, PUBLISHED_TITLE).querySelector(".episode-action"));
    await page.until(() => page.all(".concept-link").length === 1);
    click(page.byId("reader-close-btn"));
    click(page.byId("tab-custom"));
    click(page.byId("tab-library"));
    await page.until(() => page.all(".library-item").length === 1);
    click(page.byId("add-podcast-btn"));
    const input = page.byId("drawer-search") as HTMLInputElement;
    input.value = "新节目";
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    await page.until(() => page.all(".search-result").length === 1);

    expect(page.sent.length).toBeGreaterThan(5);
    expect(page.sent.filter(req => req.method !== "GET" || !req.path.startsWith("/api/public/"))).toEqual([]);
    expect(stateSnapshot(cloud)).toEqual(before);
  });
});

describe("Public Browse Mode：受保护操作在操作边界进入 Cloudflare Access", () => {
  async function expectAccess(page: Page, act: () => void, target: string) {
    const before = stateSnapshot(cloud);
    const sentBefore = page.sent.length;
    act();
    await page.until(() => page.navigations.length > 0);
    expect(page.navigations).toEqual([target]);
    // 受保护操作本身不发任何请求；允许的只有「选中单集」带来的公共只读 GET（如按需加载简介）
    expect(page.sent.slice(sentBefore).filter(req => req.method !== "GET" || !req.path.startsWith("/api/public/"))).toEqual([]);
    expect(stateSnapshot(cloud)).toEqual(before);
  }
  const manage = (query: Record<string, string>) => `/manage?${new URLSearchParams(query).toString()}`;

  it("订阅搜索结果", async () => {
    const page = await openAnonymousWorkspace();
    click(page.byId("add-podcast-btn"));
    const input = page.byId("drawer-search") as HTMLInputElement;
    input.value = "新节目";
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    await page.until(() => page.all(".search-result").length === 1);
    await expectAccess(page, () => click(page.document.querySelector(".search-result .solid-btn")), manage({ intent: "subscribe" }));
  });

  it("生成稿件（单集列表与检视栏）", async () => {
    const page = await openAnonymousWorkspace();
    await expectAccess(page, () => click(episodeRow(page, PENDING_TITLE).querySelector(".episode-action")), manage({ intent: "generate", podcast: PODCAST }));
    page.navigations.length = 0;
    await expectAccess(page, () => click(page.document.querySelector("#inspector-actions .solid-btn")), manage({ intent: "generate", podcast: PODCAST }));
  });

  it("公开态不渲染重新生成和取消订阅等主人控件", async () => {
    const page = await openAnonymousWorkspace();
    expect(episodeRow(page, PUBLISHED_TITLE).querySelector(".rerun")).toBeNull();
    expect(page.document.querySelector(`.podcast-item[data-name="${PODCAST}"] .pod-delete-btn`)).toBeNull();
  });

  it("刷新 RSS", async () => {
    const page = await openAnonymousWorkspace();
    expect(page.byId("refresh-btn").hidden).toBe(false);
    await expectAccess(page, () => click(page.byId("refresh-btn")), manage({ intent: "refresh" }));
  });

  it("导入：选择文件、拖入文件与提交都需要 Access；导入界面本身可见", async () => {
    const page = await openAnonymousWorkspace();
    click(page.byId("tab-custom"));
    expect(page.byId("custom-panel").classList.contains("is-active")).toBe(true);
    let pickerOpened = false;
    page.byId("audio-file-input").addEventListener("click", () => { pickerOpened = true; });
    await expectAccess(page, () => click(page.byId("upload-drop-zone")), manage({ intent: "import" }));
    expect(pickerOpened).toBe(false);
    page.navigations.length = 0;
    await expectAccess(page, () => {
      const drop = new page.window.Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
      drop.dataTransfer = { files: [{ name: "a.mp3", size: 1024, type: "audio/mpeg", slice: () => new Uint8Array(1024) }] };
      page.byId("upload-drop-zone").dispatchEvent(drop);
    }, manage({ intent: "import" }));
    page.navigations.length = 0;
    await expectAccess(page, () => click(page.byId("custom-submit-btn")), manage({ intent: "import" }));
  });

  it("设置", async () => {
    const page = await openAnonymousWorkspace();
    await expectAccess(page, () => click(page.byId("settings-btn")), manage({ intent: "settings" }));
    expect(page.byId("settings-drawer").classList.contains("is-open")).toBe(false);
  });

  it("挂在子路径下时，浏览请求与 Access 入口都带上同一个 base path", async () => {
    // 这里只验证前端拼出的地址；子路径的反向代理不在 Worker 测试范围内。
    const page = openPage("/podcast/");
    await page.until(() => page.sent.length >= 2);
    expect(page.sent.map(req => req.path).sort()).toEqual([
      "/podcast/api/public/preferences",
      "/podcast/api/public/subscriptions",
    ]);
    click(page.byId("settings-btn"));
    expect(page.navigations).toEqual(["/podcast/manage?intent=settings"]);
  });
});

describe("Authenticated Control Mode：同一界面，原有操作照常执行", () => {
  async function openControlWorkspace(path = "/manage"): Promise<Page> {
    // 控制面的 GET /episodes 会为过期快照安排 RSS 刷新；这里只验证界面行为，所以让快照保持新鲜。
    cloud.d1.raw.prepare("UPDATE subscriptions SET episodes_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").run();
    const page = openPage(path);
    await page.until(() => page.all(".episode-item[data-episode-title]").length === 2 && page.sent.some(req => req.path === "/api/control/tasks"));
    return page;
  }

  it("加载控制面数据（订阅、单集、任务、已读），不访问公共接口", async () => {
    const page = await openControlWorkspace();
    expect(page.document.documentElement.dataset.surface).toBe("manage");
    for (const path of ["/api/control/subscriptions", "/api/control/tasks"]) expect(page.sent).toContainEqual({ method: "GET", path });
    expect(page.sent.some(req => req.path.startsWith("/api/control/episodes/read"))).toBe(true);
    expect(page.sent.some(req => req.path.startsWith("/api/control/episodes/page?limit=10&offset=0"))).toBe(true);
    expect(page.sent.filter(req => req.path.startsWith("/api/public/"))).toEqual([]);
    expect(episodeRow(page, PUBLISHED_TITLE).querySelector(".status-tag")?.textContent).toBe("待读");
  });

  it("生成稿件直接创建任务", async () => {
    const page = await openControlWorkspace();
    click(episodeRow(page, PENDING_TITLE).querySelector(".episode-action"));
    await page.until(() => page.sent.some(req => req.method === "POST" && req.path === "/api/control/tasks"));
    expect(page.navigations).toEqual([]);
    // 按稳定的单集 id 创建（不是节目名 + 标题匹配）
    expect(cloud.d1.raw.prepare("SELECT episode_id, episode_title FROM tasks WHERE status = 'queued'").all()).toEqual([{ episode_id: "1:477", episode_title: PENDING_TITLE }]);
  });

  it("控制态保留直接的删除、下载与重新生成动作", async () => {
    const page = await openControlWorkspace();
    expect(page.document.querySelector(`.podcast-item[data-name="${PODCAST}"] .pod-delete-btn`)).not.toBeNull();
    const row = episodeRow(page, PUBLISHED_TITLE);
    expect(row.querySelector(".episode-download-action")).not.toBeNull();
    expect(row.querySelector(".rerun")?.textContent).toBe("重新生成");
    expect(row.querySelector("details")).toBeNull();
  });

  it("设置直接打开并读取配置", async () => {
    const page = await openControlWorkspace();
    click(page.byId("settings-btn"));
    await page.until(() => page.sent.some(req => req.path === "/api/control/settings"));
    expect(page.byId("settings-drawer").classList.contains("is-open")).toBe(true);
    expect(page.navigations).toEqual([]);
  });

  it("阅读：下载与已读切换都是直接工具栏动作", async () => {
    const page = await openControlWorkspace();
    click(episodeRow(page, PUBLISHED_TITLE).querySelector(".episode-action"));
    await page.until(() => page.byId("manuscript-body").textContent?.includes("康熙年间的故事"));
    const download = page.byId("reader-download") as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe(`/api/control/tasks/${PUBLISHED}/download`);
    expect(download.closest("details")).toBeNull();
    expect(page.byId("reader-read-toggle").hidden).toBe(false);
    expect(page.byId("reader-read-toggle").closest("details")).toBeNull();
  });

  it("已读按单集的 episode_id 记：阅读器里切换已读写入 D1，列表随之显示「已读」", async () => {
    const page = await openControlWorkspace();
    click(episodeRow(page, PUBLISHED_TITLE).querySelector(".episode-action"));
    await page.until(() => page.byId("manuscript-body").textContent?.includes("康熙年间的故事"));
    const readRows = () => cloud.d1.raw.prepare("SELECT episode_id, task_id FROM read_state").all().map(row => ({ ...row }));
    // 稿件很短，打开即读到末尾：自动标记已读
    await page.until(() => readRows().length === 1);
    expect(readRows()).toEqual([{ episode_id: "1:474", task_id: null }]);
    await page.until(() => episodeRow(page, PUBLISHED_TITLE).querySelector(".status-tag")?.textContent === "已读");
    await page.until(() => page.byId("filter-read-count").textContent === "1");
    // 工具栏切换回未读：按同一个 episode_id 删除
    click(page.byId("reader-read-toggle"));
    await page.until(() => readRows().length === 0);
  });

  it("从公开浏览带来的 intent 在登录后恢复，并从地址里清掉", async () => {
    cloud.d1.raw.prepare("UPDATE subscriptions SET episodes_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").run();
    const settings = openPage("/manage?intent=settings");
    await settings.until(() => settings.sent.some(req => req.path === "/api/control/settings"));
    expect(settings.byId("settings-drawer").classList.contains("is-open")).toBe(true);
    expect(settings.window.location.search).toBe("");

    const generate = await openControlWorkspace(`/manage?${new URLSearchParams({ intent: "generate", podcast: PODCAST })}`);
    await generate.until(() => generate.byId("center-title").textContent === PODCAST);
    expect(generate.window.location.search).toBe("");
  });
});
