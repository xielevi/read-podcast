import { publishedMarkdown } from "./public";
import { parseStoredBrief, type ArticleBrief } from "./refinement/brief";
import type { Env } from "./types";

// Public Browse Mode 的页面路由（不是 API）：每篇已发布稿件的永久链接与爬虫入口。
//   /a/<task_id>  稿件页：SPA 的 index.html + 服务端注入的 <head>（标题、描述、canonical、
//                 Open Graph / Twitter card）与 <noscript> 正文，供分享预览与搜索引擎抓取；
//   /sitemap.xml  首页与全部已发布稿件页；
//   /feed.xml     最近发布稿件的 Atom feed：条目正文是导读（brief），链接回稿件页；
//   /robots.txt   允许 / 与 /a/，禁止 /manage 与 /api/control/。
// 与 /api/public/* 同一组只读保证：只接受 GET / HEAD，不写 D1 / R2，只暴露已发布稿件
// （articles 表中存在）的白名单字段；Store 路径与 commit 永不出现在响应中，也不泄露任务状态。
// 正文读取复用 publicArticleContent 的发布快照路径与边缘缓存（publishedMarkdown）。

const SITE_NAME = "Read Podcast";
const SITE_IMAGE = "/og.png";
const DESCRIPTION_LENGTH = 160;
const SITEMAP_LIMIT = 50000;
const FEED_LIMIT = 30;
const ARTICLE_PATH = /^\/a(?:\/([^/]*))?\/?$/;
const TASK_ID = /^[0-9a-f-]{1,64}$/i;

interface ArticlePageRow {
  task_id: string;
  title: string;
  podcast_name: string;
  content_path: string;
  commit_sha: string;
  created_at: string;
  updated_at: string;
  brief: string | null;
}

/** 公共页面路由：命中返回响应，否则 null（交给后续路由 / 静态资源）。 */
export async function routePublicPage(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const article = path.match(ARTICLE_PATH);
  if (!article && path !== "/sitemap.xml" && path !== "/feed.xml" && path !== "/robots.txt") return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const response = article ? await articlePage(article[1] ?? "", url, env)
    : path === "/sitemap.xml" ? await sitemap(url, env)
    : path === "/feed.xml" ? await feed(url, env)
    : robots(url);
  return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

/** 稿件的公开永久链接路径。 */
export function articlePath(taskId: string): string {
  return `/a/${encodeURIComponent(taskId)}`;
}

// ── 稿件页 ──

async function articlePage(rawId: string, url: URL, env: Env): Promise<Response> {
  let taskId = "";
  try { taskId = decodeURIComponent(rawId); } catch { /* 按未知 id 处理 */ }
  if (!TASK_ID.test(taskId)) return notFoundPage(url, env);

  const row = await env.db.prepare(
    "SELECT task_id, title, podcast_name, content_path, commit_sha, created_at, updated_at, brief FROM articles WHERE task_id = ?",
  ).bind(taskId).first<ArticlePageRow>();

  if (!row) {
    // 重新生成会把同一 episode 的 articles.task_id 换成新任务（见 src/finalize.ts）。
    // 旧链接按 tasks.episode_id 找到当前稿件后永久重定向——只限曾经成功发布过的任务
    // （它的 /a/ 链接可能已被分享）；排队 / 处理中 / 失败 / 取消的任务一律与未知 id 同样 404，
    // 不泄露其存在或与单集的关联。
    const current = await env.db.prepare(
      `SELECT articles.task_id AS task_id FROM tasks
         JOIN articles ON articles.episode_id = tasks.episode_id
        WHERE tasks.id = ? AND tasks.episode_id IS NOT NULL
          AND tasks.status = 'success' AND tasks.content_commit_sha IS NOT NULL`,
    ).bind(taskId).first<{ task_id: string }>();
    if (current?.task_id && current.task_id !== taskId) {
      return new Response(null, {
        status: 301,
        headers: { location: `${url.origin}${articlePath(current.task_id)}`, "cache-control": "public, max-age=300" },
      });
    }
    return notFoundPage(url, env);
  }

  const snapshot = await publishedMarkdown(row, url.origin, env);
  if (snapshot.status !== 200) return notFoundPage(url, env);
  const markdown = await snapshot.text();

  const hasArtwork = row.podcast_name
    ? Boolean(await env.db.prepare("SELECT 1 AS ok FROM subscriptions WHERE name = ? AND image_url IS NOT NULL AND image_url != ''")
      .bind(row.podcast_name).first())
    : false;

  const canonical = `${url.origin}${articlePath(row.task_id)}`;
  const title = row.title.trim() || SITE_NAME;
  const description = articleDescription({ markdown, brief: parseStoredBrief(row.brief)?.tldr }) || [row.podcast_name, SITE_NAME].filter(Boolean).join(" · ");
  // 节目封面（方图，summary 卡片）优先；没有封面时用站点社交预览图（public/og.png，横图）。
  const image = hasArtwork ? `${url.origin}/api/public/artwork?podcast=${encodeURIComponent(row.podcast_name)}` : `${url.origin}${SITE_IMAGE}`;

  const meta = [
    `<title>${escapeHtml(row.podcast_name ? `${title} · ${row.podcast_name}` : title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta name="read-podcast:article" content="${escapeHtml(row.task_id)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta property="article:published_time" content="${escapeHtml(row.created_at)}">`,
    `<meta property="article:modified_time" content="${escapeHtml(row.updated_at)}">`,
    `<meta name="twitter:card" content="${hasArtwork ? "summary" : "summary_large_image"}">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${escapeHtml(image)}">`,
  ].filter(Boolean).join("\n  ");

  const body = `<noscript><article class="seo-article">`
    + `<h1>${escapeHtml(title)}</h1>`
    + (row.podcast_name ? `<p>${escapeHtml(row.podcast_name)}</p>` : "")
    + renderPlainHtml(markdown)
    + `</article></noscript>`;

  return htmlResponse(injectShell(await spaShell(url, env), meta, body), 200);
}

async function notFoundPage(url: URL, env: Env): Promise<Response> {
  const meta = `<title>Not found · ${SITE_NAME}</title>\n  <meta name="robots" content="noindex">`;
  return htmlResponse(injectShell(await spaShell(url, env), meta, ""), 404);
}

/** SPA 的 index.html（静态资源）；取不到时退回最小文档，页面仍携带 head 与 noscript 正文。 */
async function spaShell(url: URL, env: Env): Promise<string> {
  const fallback = `<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <title>${SITE_NAME}</title>\n</head>\n<body>\n</body>\n</html>\n`;
  if (!env.assets) return fallback;
  try {
    const response = await env.assets.fetch(new Request(`${url.origin}/`, { method: "GET" }));
    if (!response.ok) return fallback;
    const html = await response.text();
    return /<head[\s>]/i.test(html) ? html : fallback;
  } catch {
    return fallback;
  }
}

function injectShell(html: string, meta: string, body: string): string {
  let out = /<title>[\s\S]*?<\/title>/i.test(html)
    ? html.replace(/<title>[\s\S]*?<\/title>/i, () => meta)
    : html.replace(/<\/head>/i, () => `  ${meta}\n</head>`);
  if (body) out = out.replace(/<body[^>]*>/i, match => `${match}\n  ${body}`);
  return out;
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

// ── 描述与正文 ──

/**
 * 稿件的分享 / 搜索描述（约 160 字）：去掉 frontmatter 与开头的「节目大纲与时间线」，
 * 取第一段有意义的正文。描述只在这里生成；提供 brief（摘要字段）时优先使用它。
 */
export function articleDescription(source: { markdown: string; brief?: string | null }): string {
  const brief = plainInline(source.brief ?? "");
  if (brief) return truncate(brief, DESCRIPTION_LENGTH);
  for (const block of markdownBlocks(stripOutline(source.markdown))) {
    if (block.kind !== "p") continue;
    const text = plainInline(block.text);
    // 跳过只有标点 / 时间戳之类的短碎片，取第一段真正的正文。
    if (text.replace(/[\s\d:：.,，。\-–—|·()（）[\]]/g, "").length < 8) continue;
    return truncate(text, DESCRIPTION_LENGTH);
  }
  return "";
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

const OUTLINE_HEADING = /^#{1,6}\s+(?:(?:📌|⏱️|⏱|🕒)\s*)?(?:节目大纲与时间线|(?:Episode\s+)?Outline\s*(?:&|and)\s*Timeline|Timeline\s*(?:&|and)\s*Outline)\s*[:：]?[^\S\n]*(?:\n|$)/iu;

/** 去掉 frontmatter 与开头的大纲段（与阅读器 stripOpeningOutline 同一规则：到下一个标题或分隔线为止）。 */
function stripOutline(markdown: string): string {
  const body = String(markdown ?? "").replace(/\r\n?/g, "\n").replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n*/, "").trimStart();
  const heading = body.match(OUTLINE_HEADING);
  if (!heading) return body;
  const rest = body.slice(heading[0].length);
  const nextHeading = rest.search(/(?:^|\n)#{1,6}\s+\S/);
  if (nextHeading !== -1) return rest.slice(nextHeading).replace(/^\n/, "");
  const rule = rest.match(/(?:^|\n)\s*(?:---|\*\*\*|___)\s*(?:\n|$)/);
  return rule && rule.index !== undefined ? rest.slice(rule.index + rule[0].length) : "";
}

type Block = { kind: "h"; level: number; text: string } | { kind: "p"; text: string };

function markdownBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "p", text: paragraph.join(" ") });
    paragraph = [];
  };
  let inCode = false;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) { flush(); inCode = !inCode; continue; }
    if (inCode) continue;
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { flush(); blocks.push({ kind: "h", level: heading[1].length, text: heading[2] }); continue; }
    if (!trimmed || /^((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(trimmed)) { flush(); continue; }
    paragraph.push(trimmed.replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s?)/, ""));
  }
  flush();
  return blocks;
}

/** 去掉行内 Markdown 标记，只留文字。 */
function plainInline(text: string): string {
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** 供爬虫阅读的正文：只有标题与段落，全部是转义后的纯文本。 */
function renderPlainHtml(markdown: string): string {
  return markdownBlocks(stripOutline(markdown)).map(block => {
    const text = escapeHtml(plainInline(block.text));
    if (!text) return "";
    if (block.kind === "h") {
      const level = Math.min(6, block.level + 1);
      return `<h${level}>${text}</h${level}>`;
    }
    return `<p>${text}</p>`;
  }).join("");
}

// ── sitemap / robots ──

async function sitemap(url: URL, env: Env): Promise<Response> {
  const rows = await env.db.prepare("SELECT task_id, updated_at FROM articles ORDER BY updated_at DESC LIMIT ?")
    .bind(SITEMAP_LIMIT).all<{ task_id: string; updated_at: string }>();
  const entries = [`  <url><loc>${escapeHtml(`${url.origin}/`)}</loc></url>`];
  for (const row of rows.results) {
    entries.push(`  <url><loc>${escapeHtml(`${url.origin}${articlePath(row.task_id)}`)}</loc><lastmod>${escapeHtml(row.updated_at)}</lastmod></url>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}

// ── Atom feed ──
// 只读 D1（articles.title / podcast_name / brief / 时间），不读 Store：条目正文就是导读，
// 没有导读的旧稿件只给标题与节目名，读者点链接进稿件页读全文。

interface FeedRow {
  task_id: string;
  title: string;
  podcast_name: string;
  created_at: string;
  updated_at: string;
  brief: string | null;
}

const FEED_LABELS = {
  zh: { keyPoints: "要点", audience: "适合谁读：", readFull: (minutes: number) => minutes ? `阅读全文（约 ${minutes} 分钟）` : "阅读全文" },
  en: { keyPoints: "Key points", audience: "Who should read: ", readFull: (minutes: number) => minutes ? `Read the full text (~${minutes} min)` : "Read the full text" },
};

async function feed(url: URL, env: Env): Promise<Response> {
  const rows = await env.db.prepare(
    "SELECT task_id, title, podcast_name, created_at, updated_at, brief FROM articles ORDER BY created_at DESC LIMIT ?",
  ).bind(FEED_LIMIT).all<FeedRow>();
  const selfUrl = `${url.origin}/feed.xml`;
  const updated = rows.results.reduce((latest, row) => row.updated_at > latest ? row.updated_at : latest, "1970-01-01T00:00:00.000Z");
  const entries = rows.results.map((row) => {
    const link = `${url.origin}${articlePath(row.task_id)}`;
    const brief = parseStoredBrief(row.brief);
    const summary = brief?.tldr || row.podcast_name || SITE_NAME;
    return [
      "  <entry>",
      `    <id>${escapeHtml(link)}</id>`,
      `    <title>${escapeHtml(row.title.trim() || SITE_NAME)}</title>`,
      `    <link rel="alternate" type="text/html" href="${escapeHtml(link)}"/>`,
      `    <published>${escapeHtml(row.created_at)}</published>`,
      `    <updated>${escapeHtml(row.updated_at)}</updated>`,
      row.podcast_name ? `    <author><name>${escapeHtml(row.podcast_name)}</name></author>` : "",
      `    <summary>${escapeHtml(summary)}</summary>`,
      `    <content type="html">${escapeHtml(feedEntryHtml(row, brief, link))}</content>`,
      "  </entry>",
    ].filter(Boolean).join("\n");
  });
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeHtml(selfUrl)}</id>`,
    `  <title>${SITE_NAME}</title>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeHtml(selfUrl)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeHtml(`${url.origin}/`)}"/>`,
    `  <updated>${escapeHtml(updated)}</updated>`,
    ...entries,
    "</feed>",
    "",
  ].join("\n");
  return new Response(xml, { headers: { "content-type": "application/atom+xml; charset=utf-8", "cache-control": "public, max-age=900" } });
}

/** 条目正文（HTML，随后整体转义进 <content type="html">）：导读卡的纯文本版 + 回到稿件页的链接。 */
function feedEntryHtml(row: FeedRow, brief: ArticleBrief | null, link: string): string {
  const labels = /[\u3400-\u9fff]/.test(`${row.title}${brief?.tldr ?? ""}`) ? FEED_LABELS.zh : FEED_LABELS.en;
  const parts: string[] = [];
  if (row.podcast_name) parts.push(`<p><em>${escapeHtml(row.podcast_name)}</em></p>`);
  if (brief) {
    parts.push(`<p>${escapeHtml(brief.tldr)}</p>`);
    parts.push(`<p><strong>${labels.keyPoints}</strong></p><ul>${brief.key_points.map(point => `<li>${escapeHtml(point)}</li>`).join("")}</ul>`);
    for (const quote of brief.quotes) {
      parts.push(`<blockquote><p>${escapeHtml(quote.text)}</p><p>— ${escapeHtml(quote.speaker)}</p></blockquote>`);
    }
    if (brief.audience) parts.push(`<p><strong>${labels.audience}</strong>${escapeHtml(brief.audience)}</p>`);
  }
  parts.push(`<p><a href="${escapeHtml(link)}">${escapeHtml(labels.readFull(brief?.reading_minutes ?? 0))}</a></p>`);
  return parts.join("");
}

function robots(url: URL): Response {
  const text = [
    "User-agent: *",
    "Allow: /",
    "Allow: /a/",
    "Disallow: /manage",
    "Disallow: /api/control/",
    "",
    `Sitemap: ${url.origin}/sitemap.xml`,
    "",
  ].join("\n");
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}

/** HTML / XML 通用转义（属性值与文本节点都安全）。 */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
