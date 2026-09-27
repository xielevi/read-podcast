import { HttpError, error, json, parseLimit, parseOffset } from "./http";
import { EPISODE_TTL_MS, refreshFeed, refreshFeedInBackground, type SubscriptionRow } from "./episodes";
import type { Env } from "./types";

/**
 * GET /api/public/episodes/page 与 /api/control/episodes/page —— 单集列表的服务端分页。
 *
 *   ?podcast_name=  节目名；缺省 = 全部订阅的时间线
 *   ?q=             标题搜索（子串）
 *   ?filter=        all | readable（待读）| unread（未生成）| read（已读）
 *   ?limit= ?offset=
 *
 * 返回 `{ items, total, counts, cache_state }`：items 只是当前一页（不含简介，简介按需读取），
 * total 是当前筛选 + 搜索下的总数，counts 是节目范围内各筛选的数量（不受搜索影响）。
 * 前端从不一次拿到整档节目 / 全部订阅的单集。
 *
 * 公共面只读 D1 快照：没有已读 / 任务状态，「已读」恒为 0，「未生成」= 没有已发布稿件。
 * 控制面额外按 SWR 刷新范围内的订阅（见 refreshScope），并把已读与进行中的任务计入筛选。
 */

export type EpisodeFilter = "all" | "readable" | "unread" | "read";
const FILTERS = new Set<EpisodeFilter>(["all", "readable", "unread", "read"]);

export type Plane = "public" | "control";

export interface EpisodePageItem {
  id: string;
  podcast_name: string;
  title: string;
  published: string;
  duration_seconds: number;
  article_task_id: string | null;
}

export interface EpisodePage {
  items: EpisodePageItem[];
  total: number;
  counts: Record<EpisodeFilter, number>;
  cache_state: "complete" | "stale";
}

// 一集是否「已有稿件」：按单集 id 关联，或（历史稿件）按节目名 + 标题关联。
// 拆成两个 EXISTS：各自走索引（idx_articles_episode_id / idx_articles_podcast_title），不扫描 articles。
const HAS_ARTICLE = "(EXISTS (SELECT 1 FROM articles a WHERE a.episode_id = e.id) OR EXISTS (SELECT 1 FROM articles a WHERE a.podcast_name = e.podcast_name AND a.title = e.title))";
const IS_READ = "EXISTS (SELECT 1 FROM read_state r WHERE r.episode_id = e.id)";
const IS_ACTIVE = "EXISTS (SELECT 1 FROM tasks t WHERE t.episode_id = e.id AND t.status IN ('queued', 'transcribing', 'refining', 'finalizing'))";

function predicates(plane: Plane): Record<EpisodeFilter, string> {
  // 公共面不暴露已读与任务状态
  const read = plane === "control" ? IS_READ : "0";
  const active = plane === "control" ? IS_ACTIVE : "0";
  return {
    all: "1",
    readable: `(${HAS_ARTICLE} AND NOT ${read})`,
    unread: `(NOT ${HAS_ARTICLE} AND NOT ${active})`,
    read,
  };
}

// 日期未知（'UnknownDate' / 空）的单集排在最后；与 idx_episodes_timeline 的列一致
const ORDER = "ORDER BY (e.published_date GLOB '[0-9]*') DESC, e.published_date DESC, e.id";

async function queryPage(env: Env, plane: Plane, podcastName: string, q: string, filter: EpisodeFilter, limit: number, offset: number) {
  const where = predicates(plane);
  // 只在需要时拼条件（不用「? = '' OR …」这种会让索引失效的写法）
  const scope: string[] = [];
  const scopeParams: unknown[] = [];
  if (podcastName) {
    scope.push("e.podcast_name = ?");
    scopeParams.push(podcastName);
  }
  const matching = [...scope];
  const matchingParams = [...scopeParams];
  if (q) {
    matching.push("instr(lower(e.title), lower(?)) > 0");
    matchingParams.push(q);
  }
  if (filter !== "all") matching.push(where[filter]);
  const whereClause = (conditions: string[]) => (conditions.length ? `WHERE ${conditions.join(" AND ")}` : "");

  const [items, total, counts] = await env.DB.batch([
    env.DB.prepare(`SELECT e.id, e.podcast_name, e.title, e.published, e.duration_seconds,
        COALESCE(
          (SELECT a.task_id FROM articles a WHERE a.episode_id = e.id LIMIT 1),
          (SELECT a.task_id FROM articles a WHERE a.podcast_name = e.podcast_name AND a.title = e.title LIMIT 1)
        ) AS article_task_id
      FROM episodes e ${whereClause(matching)} ${ORDER} LIMIT ? OFFSET ?`).bind(...matchingParams, limit, offset),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM episodes e ${whereClause(matching)}`).bind(...matchingParams),
    env.DB.prepare(`SELECT COUNT(*) AS all_count,
        COALESCE(SUM(${where.readable}), 0) AS readable,
        COALESCE(SUM(${where.unread}), 0) AS unread,
        COALESCE(SUM(${where.read}), 0) AS read
      FROM episodes e ${whereClause(scope)}`).bind(...scopeParams),
  ]);
  const row = (counts.results[0] ?? {}) as Record<string, number>;
  return {
    items: (items.results as Array<Record<string, unknown>>).map((item): EpisodePageItem => ({
      id: String(item.id ?? ""),
      podcast_name: String(item.podcast_name ?? ""),
      title: String(item.title ?? ""),
      published: String(item.published ?? ""),
      duration_seconds: Number(item.duration_seconds ?? 0),
      article_task_id: item.article_task_id == null ? null : String(item.article_task_id),
    })),
    total: Number((total.results[0] as { n?: number } | undefined)?.n ?? 0),
    counts: { all: Number(row.all_count ?? 0), readable: Number(row.readable ?? 0), unread: Number(row.unread ?? 0), read: Number(row.read ?? 0) },
  };
}

/** 单次请求里最多同步 / 后台刷新几档节目的 RSS（子请求预算；其余留给之后的请求）。 */
export const MAX_FEED_REFRESHES_PER_REQUEST = 5;

/**
 * 控制面的 SWR：
 *   - force：同步刷新范围内最久未同步的几档；
 *   - 打开一个范围的第一页（无搜索 / 筛选）：从未同步的订阅先同步再列出；
 *   - 其余（翻页、搜索、切筛选）绝不等待 RSS：从未同步与已过期的订阅都交给后台刷新。
 * 刷新失败不影响列出 D1 快照，只把 cache_state 标成 stale。
 */
async function refreshScope(env: Env, subs: SubscriptionRow[], mode: "force" | "open" | "browse", ctx?: ExecutionContext): Promise<"complete" | "stale"> {
  const syncedAt = (sub: SubscriptionRow) => (sub.episodes_synced_at ? Date.parse(sub.episodes_synced_at) : NaN);
  const byOldest = [...subs].sort((a, b) => (syncedAt(a) || 0) - (syncedAt(b) || 0));
  const neverSynced = (sub: SubscriptionRow) => !Number.isFinite(syncedAt(sub));
  const awaited = mode === "force" ? byOldest : mode === "open" ? byOldest.filter(neverSynced) : [];
  const background = mode === "force" ? [] : byOldest.filter(sub => !awaited.includes(sub) && (neverSynced(sub) || Date.now() - syncedAt(sub) >= EPISODE_TTL_MS));

  const results = await Promise.allSettled(
    awaited.slice(0, MAX_FEED_REFRESHES_PER_REQUEST).map(sub => refreshFeed(env, sub.rss_url, sub.name)),
  );
  const refreshFailed = results.some(result => result.status === "rejected");
  const pending = background.slice(0, MAX_FEED_REFRESHES_PER_REQUEST);
  if (pending.length && ctx) {
    ctx.waitUntil((async () => {
      for (const sub of pending) await refreshFeedInBackground(env, sub.rss_url, sub.name);
    })());
  }
  return refreshFailed || awaited.length > MAX_FEED_REFRESHES_PER_REQUEST || pending.length > 0 ? "stale" : "complete";
}

export async function listEpisodePage(url: URL, env: Env, plane: Plane, ctx?: ExecutionContext): Promise<Response> {
  const podcastName = (url.searchParams.get("podcast_name") ?? "").trim();
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const rawFilter = (url.searchParams.get("filter") ?? "all").trim() as EpisodeFilter;
  if (!FILTERS.has(rawFilter)) throw new HttpError(400, "invalid_request", "filter must be all, readable, unread or read");
  const limit = parseLimit(url, 20, 100);
  const offset = parseOffset(url);

  const subs = await env.DB.prepare(
    `SELECT id, name, rss_url, image_url, episodes_synced_at FROM subscriptions${podcastName ? " WHERE name = ?" : ""}`,
  ).bind(...(podcastName ? [podcastName] : [])).all<SubscriptionRow>();
  if (podcastName && !subs.results.length) return error(404, "podcast_not_found", `Podcast '${podcastName}' not found`);

  // 公共面严格无副作用：不刷新 RSS，快照过期也原样返回
  const mode = url.searchParams.get("force") === "true" ? "force" : offset === 0 && !q && rawFilter === "all" ? "open" : "browse";
  const cacheState = plane === "control" ? await refreshScope(env, subs.results, mode, ctx) : "complete";

  const page = await queryPage(env, plane, podcastName, q, rawFilter, limit, offset);
  const body: EpisodePage = { ...page, cache_state: cacheState };
  return json(body);
}
