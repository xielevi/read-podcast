import { HttpError, error, json, parseLimit, parseOffset } from "./http";
import { readPodcastContent } from "./github";
import { sha256Hex } from "./crypto";
import { proxyArtwork, searchItunes } from "./episodes";
import type { Env } from "./types";

// Public Browse Mode：匿名可访问的只读面（/api/public/*），支撑与控制模式同一套工作区的浏览。
// 每个处理函数都严格无副作用：只读 D1（订阅、单集快照、articles、article_concepts）、
// Canonical Manuscript Store，以及纯查询的外部目录（播客检索、封面图）；
// 不写 D1 / R2、不刷新 RSS、不启动任务、不调用精修模型，也不暴露任务 / 已读 / 设置等控制面状态。
// 只有已发布（articles 表中存在）的稿件对外可见；稿件在 Store 中的路径与 commit 不对外返回。

const SEARCH_CACHE_SECONDS = 60 * 60;
// 已发布正文在边缘的缓存时长。正文按发布时的 commit 读取、以 content_path@commit_sha 为键，
// 内容不可变，这个时长只影响边缘存储占用，不影响正确性。
const MANUSCRIPT_CACHE_SECONDS = 24 * 60 * 60;
const MAX_SEARCH_QUERY_LENGTH = 100;
// iTunes 检索结果的封面来自 Apple 的公开图片 CDN，可以按 URL 代理；订阅封面只按节目名代理。
const SEARCH_ARTWORK_HOST = /(^|\.)mzstatic\.com$/i;

// 公共面的响应一律是显式白名单 DTO，绝不把 D1 行原样透出：私有 / 付费播客常把凭据放在
// RSS 地址、音频地址或封面地址的 path / query 里，这些原始 URL 只属于控制面。

/** 公开的订阅：只有名称、来源域名（不含 path / query / 凭据），以及是否有可代理的封面。 */
export interface PublicSubscription {
  name: string;
  source_host: string;
  has_artwork: boolean;
}

function sourceHost(rssUrl: string): string {
  try {
    return new URL(rssUrl).hostname;
  } catch {
    return "";
  }
}

/** GET /api/public/subscriptions —— 当前订阅列表（供左栏浏览）。 */
export async function publicListSubscriptions(env: Env): Promise<Response> {
  const result = await env.db.prepare(
    "SELECT name, rss_url, image_url FROM subscriptions ORDER BY name COLLATE NOCASE",
  ).all<{ name: string; rss_url: string; image_url: string }>();
  return json(result.results.map((row): PublicSubscription => ({
    name: row.name,
    source_host: sourceHost(row.rss_url),
    has_artwork: Boolean(row.image_url),
  })));
}

// ── 边缘缓存：匿名流量不直达上游（iTunes / 封面源 / Canonical Manuscript Store 的 GitHub 配额） ──

/** Workers 的 caches.default；lib.webworker 的 CacheStorage 类型里没有它，本地测试环境也没有 caches。 */
function edgeCache(): Cache | null {
  return typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default;
}

/**
 * 按 key 命中边缘缓存，否则调用 produce()；只缓存 200。produce 的响应必须带 public 的
 * cache-control（Cache API 按它决定是否保存、保存多久）。缓存是纯读优化，不是第二个事实源。
 */
async function cachedAtEdge(key: string, produce: () => Promise<Response>): Promise<Response> {
  const cache = edgeCache();
  const request = new Request(key);
  const hit = await cache?.match(request);
  if (hit) return hit;
  const response = await produce();
  if (cache && response.status === 200) await cache.put(request, response.clone());
  return response;
}

/**
 * GET /api/public/search/podcast?q=… —— 纯查询的播客检索（不写任何应用状态）。
 * 匿名可达，因此限制查询长度并按规范化后的查询在边缘缓存结果，重复检索不再打到上游。
 */
export async function publicSearchPodcast(url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!q) return json([]);
  if (q.length > MAX_SEARCH_QUERY_LENGTH) throw new HttpError(400, "invalid_request", "Search query is too long");

  return cachedAtEdge(`${url.origin}/api/public/search/podcast?q=${encodeURIComponent(q)}`, async () =>
    json(await searchItunes(q), 200, { "cache-control": `public, max-age=${SEARCH_CACHE_SECONDS}` }));
}

/**
 * 封面按上游图片地址缓存（proxyArtwork 的 200 响应自带 public max-age）。订阅封面地址可能带凭据，
 * 因此缓存键只用它的 SHA-256，原始地址不进入 Cache API。
 */
async function cachedArtwork(origin: string, target: string): Promise<Response> {
  return cachedAtEdge(`${origin}/api/public/artwork?src=${await sha256Hex(target)}`, () => proxyArtwork(target));
}

/**
 * GET /api/public/artwork —— 封面代理，只服务浏览界面会展示的图片：
 *   ?podcast=<订阅名>  已订阅节目的封面：服务端按订阅查 image_url，原始地址从不下发给浏览器；
 *   ?url=<地址>        播客检索结果的封面，只接受 Apple 图片 CDN。
 * 其余请求一律 404，公共面不是通用图片代理。
 */
export async function publicArtwork(url: URL, env: Env): Promise<Response> {
  const podcast = (url.searchParams.get("podcast") ?? "").trim();
  if (podcast) {
    const row = await env.db.prepare("SELECT image_url FROM subscriptions WHERE name = ?").bind(podcast).first<{ image_url: string }>();
    if (!row?.image_url) return error(404, "artwork_not_found", "Artwork not found");
    return cachedArtwork(url.origin, row.image_url);
  }
  const target = url.searchParams.get("url") ?? "";
  let host = "";
  try { host = new URL(target).hostname; } catch { /* 下面按不允许处理 */ }
  if (!SEARCH_ARTWORK_HOST.test(host)) return error(404, "artwork_not_found", "Artwork not found");
  return cachedArtwork(url.origin, target);
}

interface PublicArticleRow {
  task_id: string;
  title: string;
  podcast_name: string;
  created_at: string;
  updated_at: string;
}

interface PublishedContentRow {
  title: string;
  content_path: string;
  commit_sha: string;
}

const PUBLIC_ARTICLE_COLUMNS = "task_id, title, podcast_name, created_at, updated_at";

/** GET /api/public/articles —— 已发布稿件列表（只含阅读所需的元数据）。 */
export async function publicListArticles(url: URL, env: Env): Promise<Response> {
  const limit = parseLimit(url, 50, 200);
  const offset = parseOffset(url);

  const result = await env.db.prepare(
    `SELECT ${PUBLIC_ARTICLE_COLUMNS} FROM articles ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<PublicArticleRow>();

  return json(result.results);
}

async function publishedContent(taskId: string, env: Env): Promise<PublishedContentRow | null> {
  return env.db.prepare("SELECT title, content_path, commit_sha FROM articles WHERE task_id = ?")
    .bind(taskId)
    .first<PublishedContentRow>();
}

/**
 * 已发布正文 = 发布快照：按 articles.commit_sha 读取 Store 中那个 commit 的文件（与 article_concepts
 * 同一版本键），而不是分支 HEAD。内容不可变，因此以 content_path@commit_sha 为键在边缘缓存，
 * 匿名阅读不再逐次消耗 Store（GitHub API）配额；换版本只能通过重新发布（commit_sha 更新）。
 * 缓存只在公共面这一层；控制面与发布流程仍直接读取分支。
 */
function publishedMarkdown(article: PublishedContentRow, origin: string, env: Env): Promise<Response> {
  const key = `${origin}/api/public/articles/cache/${encodeURIComponent(article.commit_sha)}/${encodeURIComponent(article.content_path)}`;
  return cachedAtEdge(key, async () => {
    const upstream = await readPodcastContent(env, article.content_path, article.commit_sha);
    if (!upstream.ok) return upstream;
    return new Response(upstream.body, {
      headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": `public, max-age=${MANUSCRIPT_CACHE_SECONDS}` },
    });
  });
}

/** 返回给浏览器的正文响应：浏览器侧策略不变（private, no-store），与边缘缓存的时长无关。 */
function markdownResponse(body: BodyInit | null, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "private, no-store", ...extraHeaders },
  });
}

/** GET /api/public/articles/:id/content —— 已发布稿件的 Markdown 正文。 */
export async function publicArticleContent(taskId: string, url: URL, env: Env): Promise<Response> {
  const article = await publishedContent(taskId, env);
  if (!article) return error(404, "article_not_found", "Article not found");
  const response = await publishedMarkdown(article, url.origin, env);
  if (response.status === 404) return error(404, "content_not_found", "Article content not found");
  return markdownResponse(response.body);
}

/** GET /api/public/articles/:id/download —— 以附件形式下载已发布稿件的 Markdown。 */
export async function publicArticleDownload(taskId: string, url: URL, env: Env): Promise<Response> {
  const article = await publishedContent(taskId, env);
  if (!article) return error(404, "article_not_found", "Article not found");
  const response = await publishedMarkdown(article, url.origin, env);
  if (response.status === 404) return error(404, "content_not_found", "Article content not found");
  const filename = encodeURIComponent(`${article.title || "podcast"}.md`);
  return markdownResponse(response.body, { "content-disposition": `attachment; filename*=UTF-8''${filename}` });
}

/**
 * GET /api/public/articles/:id/concepts —— 只返回已缓存的关键概念。
 * 缓存未命中时返回空列表，绝不触发抽取（抽取会调用精修模型并写 D1，属于控制面）。
 */
export async function publicArticleConcepts(taskId: string, env: Env): Promise<Response> {
  const article = await publishedContent(taskId, env);
  if (!article) return error(404, "article_not_found", "Article not found");
  const cached = await env.db.prepare("SELECT concepts_json FROM article_concepts WHERE content_path = ? AND commit_sha = ?")
    .bind(article.content_path, article.commit_sha)
    .first<{ concepts_json: string }>();
  if (cached?.concepts_json) {
    try {
      const parsed = JSON.parse(cached.concepts_json) as { concepts?: unknown };
      if (Array.isArray(parsed.concepts)) return json({ concepts: parsed.concepts });
    } catch {
      // 缓存损坏时按未命中处理；修复由控制面的重新抽取负责。
    }
  }
  return json({ concepts: [] });
}
