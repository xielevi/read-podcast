import { NOW } from "./db";
import { HttpError, error, json, parseLimit, parseOffset, readJson } from "./http";
import { readBoundedResponse, readBoundedText } from "./net/bounded";
import { checkPublicHttpUrl, type UrlRejection } from "./net/url_guard";
import { type Episode, parseFeed } from "./rss";
import type { Env } from "./types";

export const EPISODE_TTL_MS = 60 * 60 * 1000; // 1h，对齐原生 CACHE_TTL_SECONDS
const MAX_RSS_BYTES = 10 * 1024 * 1024;
const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

// ── URL 安全（Worker 侧 SSRF 收敛；规则与音频 source 共用 net/url_guard）──

const HTTP_URL_REJECTIONS: Record<UrlRejection, string> = {
  invalid: "URL must be absolute",
  protocol: "URL must be HTTP(S) without credentials",
  credentials: "URL must be HTTP(S) without credentials",
  non_public_host: "URL resolves to a non-public host",
};

export function assertPublicHttpUrl(raw: string): URL {
  const checked = checkPublicHttpUrl(raw);
  if (!checked.ok) throw new HttpError(400, "invalid_url", HTTP_URL_REJECTIONS[checked.reason]);
  return checked.url;
}

// ── 订阅 ──

export interface SubscriptionRow {
  id?: number;
  name: string;
  rss_url: string;
  image_url: string;
  episodes_synced_at: string;
}

export async function listSubscriptions(env: Env): Promise<Response> {
  const result = await env.db.prepare(
    "SELECT name, rss_url, image_url FROM subscriptions ORDER BY name COLLATE NOCASE",
  ).all<{ name: string; rss_url: string; image_url: string }>();
  // 对齐原生 PODCASTS 形状：name/rss_url/image/enabled。
  const subscriptions = result.results.map(row => ({
    name: row.name,
    rss_url: row.rss_url,
    image: row.image_url || "",
    enabled: true,
  }));
  return json(subscriptions);
}

// ── RSS 拉取 + 解析 ──

const tooLarge = (maxBytes: number) => () => new HttpError(413, "payload_too_large", `Payload exceeds size limit of ${maxBytes} bytes`);

export async function readBoundedBytes(response: Response, maxBytes: number, tooLargeError?: HttpError): Promise<Uint8Array> {
  return readBoundedResponse(response, maxBytes, tooLargeError ? () => tooLargeError : tooLarge(maxBytes));
}

export async function readBoundedString(response: Response, maxBytes: number, tooLargeError?: HttpError): Promise<string> {
  return readBoundedText(response, maxBytes, tooLargeError ? () => tooLargeError : tooLarge(maxBytes));
}

async function fetchFeed(rssUrl: string, podcastName: string): Promise<{ channelImage: string; episodes: Episode[] }> {
  assertPublicHttpUrl(rssUrl);
  const response = await fetch(rssUrl, {
    headers: {
      "user-agent": "ReadPodcastEdge/1.0",
      accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new HttpError(502, "rss_unreachable", `RSS fetch failed (${response.status})`);
  const buffer = await readBoundedString(response, MAX_RSS_BYTES, new HttpError(502, "rss_too_large", "RSS feed exceeds size limit"));
  return parseFeed(buffer, podcastName);
}

/**
 * 把一次 RSS 解析结果写入 D1。内容没变的单集不写（DO UPDATE … WHERE 任一列变化）：
 * 每小时的刷新只为新增 / 变化的单集付写入，而不是整档节目重写一遍（D1 按写入行数计费）。
 */
export async function upsertEpisodes(env: Env, subscriptionName: string, episodes: Episode[]): Promise<void> {
  if (!episodes.length) return;
  const sub = await env.db.prepare("SELECT id FROM subscriptions WHERE name = ?").bind(subscriptionName).first<{ id: number }>();
  const subId = sub?.id ?? null;
  const statements = episodes.map(ep => {
    const sourceId = ep.id;
    const namespacedId = subId != null ? `${subId}:${sourceId}` : sourceId;
    return env.db.prepare(
      `INSERT INTO episodes
        (id, subscription_id, podcast_name, title, audio_url, duration_seconds,
         summary, link, published, published_date, duration, source_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW})
       ON CONFLICT(subscription_id, source_id) DO UPDATE SET
         podcast_name = excluded.podcast_name,
         title = excluded.title,
         audio_url = excluded.audio_url,
         duration_seconds = excluded.duration_seconds,
         summary = excluded.summary,
         link = excluded.link,
         published = excluded.published,
         published_date = excluded.published_date,
         duration = excluded.duration,
         updated_at = ${NOW}
       WHERE episodes.podcast_name IS NOT excluded.podcast_name
          OR episodes.title IS NOT excluded.title
          OR episodes.audio_url IS NOT excluded.audio_url
          OR episodes.duration_seconds IS NOT excluded.duration_seconds
          OR episodes.summary IS NOT excluded.summary
          OR episodes.link IS NOT excluded.link
          OR episodes.published IS NOT excluded.published
          OR episodes.published_date IS NOT excluded.published_date
          OR episodes.duration IS NOT excluded.duration`,
    ).bind(
      namespacedId, subId, ep.podcast_name, ep.title, ep.audio_url, ep.duration_seconds,
      ep.summary, ep.link, ep.published, ep.date, ep.duration, sourceId,
    );
  });
  statements.push(
    env.db.prepare(`UPDATE subscriptions SET episodes_synced_at = ${NOW} WHERE name = ?`).bind(subscriptionName),
  );
  await env.db.batch(statements);
}

function rowToEpisode(row: Record<string, unknown>): Episode {
  return {
    podcast_name: String(row.podcast_name ?? ""),
    title: String(row.title ?? ""),
    link: String(row.link ?? ""),
    audio_url: String(row.audio_url ?? ""),
    published: String(row.published ?? ""),
    date: String(row.published_date ?? ""),
    duration: String(row.duration ?? ""),
    duration_seconds: Number(row.duration_seconds ?? 0),
    summary: String(row.summary ?? ""),
    id: String(row.id ?? ""),
  };
}

/**
 * GET /api/public/episodes/summary?id=… 与 /api/control/episodes/summary?id=…：单集简介（按需加载）。
 * 只读 D1，无副作用；公共面与控制面共用。
 */
export async function getEpisodeSummary(url: URL, env: Env): Promise<Response> {
  const id = (url.searchParams.get("id") ?? "").trim();
  if (!id) throw new HttpError(400, "invalid_request", "id is required");
  const row = await env.db.prepare("SELECT summary FROM episodes WHERE id = ?").bind(id).first<{ summary: string | null }>();
  if (!row) return error(404, "episode_not_found", "Episode not found");
  return json({ id, summary: String(row.summary ?? "") });
}

/** 同步刷新一档节目：拉 RSS → 入库（失败抛出，由调用方决定如何降级）。 */
export async function refreshFeed(env: Env, rssUrl: string, podcastName: string): Promise<void> {
  const { episodes } = await fetchFeed(rssUrl, podcastName);
  await upsertEpisodes(env, podcastName, episodes);
}

const inFlightRefreshes = new Set<string>();

export async function refreshFeedInBackground(env: Env, rssUrl: string, podcastName: string): Promise<void> {
  if (inFlightRefreshes.has(podcastName)) return;
  inFlightRefreshes.add(podcastName);
  try {
    await refreshFeed(env, rssUrl, podcastName);
  } catch (err) {
    console.warn(`Background RSS refresh failed for ${podcastName}:`, err);
  } finally {
    inFlightRefreshes.delete(podcastName);
  }
}

/** 按稳定的（命名空间化）单集 id 读取 D1 中的单集；任务创建的主路径。 */
export async function episodeById(env: Env, id: string): Promise<Episode | null> {
  const row = await env.db.prepare("SELECT * FROM episodes WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return row ? rowToEpisode(row) : null;
}

export interface PodcastSearchResult {
  name: string;
  rss_url: string;
  image: string;
  author: string;
}

/** 纯查询的 iTunes 检索：只读外部目录，不写任何应用状态。 */
export async function searchItunes(q: string): Promise<PodcastSearchResult[]> {
  const endpoint = new URL("https://itunes.apple.com/search");
  endpoint.searchParams.set("term", q);
  endpoint.searchParams.set("media", "podcast");
  endpoint.searchParams.set("limit", "25");
  const response = await fetch(endpoint.toString(), { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new HttpError(502, "search_failed", "Podcast search failed");
  const data = await response.json<{ results?: Array<Record<string, unknown>> }>();
  return (data.results ?? [])
    .filter(item => item.feedUrl)
    .map(item => ({
      name: String(item.collectionName ?? item.trackName ?? ""),
      rss_url: String(item.feedUrl),
      image: String(item.artworkUrl600 ?? item.artworkUrl100 ?? ""),
      author: String(item.artistName ?? ""),
    }));
}

/** GET /search/podcast：iTunes 检索。 */
export async function searchPodcast(url: URL, _env: Env): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return json([]);
  return json(await searchItunes(q));
}

/** GET /artwork：SSRF 安全的封面代理。 */
export async function artwork(url: URL, _env: Env): Promise<Response> {
  return proxyArtwork(url.searchParams.get("url") ?? "");
}

/** 取回一张公网封面图（协议 / 私网 / 类型 / 体积均受限），原样返回图片字节。 */
export async function proxyArtwork(target: string): Promise<Response> {
  assertPublicHttpUrl(target);
  const response = await fetch(target, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return error(502, "artwork_failed", "Artwork fetch failed");
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) return error(415, "artwork_type", "Unsupported artwork type");
  try {
    const bytes = await readBoundedBytes(
      response,
      MAX_ARTWORK_BYTES,
      new HttpError(413, "artwork_too_large", "Artwork too large"),
    );
    return new Response(bytes.buffer as ArrayBuffer, {
      headers: { "content-type": contentType, "cache-control": "public, max-age=86400" },
    });
  } catch (err) {
    if (err instanceof HttpError) return error(err.status, err.code, err.message);
    return error(502, "artwork_failed", "Failed to stream artwork");
  }
}

// ── 已读状态：按稿件的稳定身份记（RSS 单集 = episode_id；导入音频 = 稿件 task_id），见迁移 0020 ──

export interface ReadRef {
  episode_id: string | null;
  task_id: string | null;
}

export async function getReadState(url: URL, env: Env): Promise<Response> {
  const limit = parseLimit(url, 200, 500);
  const offset = parseOffset(url);
  const result = await env.db.prepare(
    "SELECT episode_id, task_id FROM read_state ORDER BY read_at DESC LIMIT ? OFFSET ?",
  ).bind(limit + 1, offset).all<ReadRef>();
  const rows = result.results;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(row => ({ episode_id: row.episode_id ?? null, task_id: row.task_id ?? null }));
  return json({ items, next_offset: hasMore ? offset + limit : null });
}

export async function putReadState(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ episode_id?: unknown; task_id?: unknown; read?: boolean }>(request);
  const episodeId = typeof body.episode_id === "string" ? body.episode_id.trim() : "";
  const taskId = typeof body.task_id === "string" ? body.task_id.trim() : "";
  if (Boolean(episodeId) === Boolean(taskId)) {
    throw new HttpError(400, "invalid_request", "exactly one of episode_id or task_id is required");
  }
  const column = episodeId ? "episode_id" : "task_id";
  const value = episodeId || taskId;
  if (body.read) {
    await env.db.prepare(
      `INSERT INTO read_state (${column}, read_at) VALUES (?, ${NOW})
       ON CONFLICT(${column}) DO UPDATE SET read_at = ${NOW}`,
    ).bind(value).run();
  } else {
    await env.db.prepare(`DELETE FROM read_state WHERE ${column} = ?`).bind(value).run();
  }
  return json({ ok: true });
}
