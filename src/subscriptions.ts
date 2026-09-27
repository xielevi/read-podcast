import { NOW } from "./db";
import { HttpError, error, json, readJson } from "./http";
import { assertPublicHttpUrl, readBoundedString, upsertEpisodes } from "./episodes";
import { type Episode, parseFeed } from "./rss";
import type { Env } from "./types";

interface SubscriptionBody { name: string; rss_url: string; image?: string; image_url?: string }

async function channelDetailsOf(rssUrl: string, name: string): Promise<{ ok: boolean; image: string; title: string; episodes: Episode[] }> {
  try {
    const response = await fetch(rssUrl, {
      headers: { "user-agent": "ReadPodcastEdge/1.0", accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { ok: false, image: "", title: "", episodes: [] };
    const xml = await readBoundedString(response, 10 * 1024 * 1024);
    const { channelImage, channelTitle, episodes } = parseFeed(xml, name);
    return { ok: true, image: channelImage, title: channelTitle, episodes };
  } catch {
    return { ok: false, image: "", title: "", episodes: [] };
  }
}

export async function createSubscription(request: Request, env: Env): Promise<Response> {
  const body = await readJson<SubscriptionBody>(request);
  const requestedName = typeof body.name === "string" ? body.name.trim().slice(0, 300) : "";
  const rss = assertPublicHttpUrl(body.rss_url);

  // 校验 RSS 可达；缺省封面回退到频道封面（对齐原生）。
  const provided = (body.image ?? body.image_url ?? "").toString().slice(0, 4096);
  const feed = await channelDetailsOf(rss.toString(), requestedName);
  if (!feed.ok) throw new HttpError(502, "rss_unreachable", "RSS 源无法访问，请检查地址");
  const name = requestedName || feed.title.slice(0, 300);
  if (!name) throw new HttpError(400, "invalid_feed", "无法识别节目名称");
  const image = provided || feed.image || "";

  const result = await env.db.prepare(`INSERT INTO subscriptions (name, rss_url, image_url) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET rss_url = excluded.rss_url, image_url = excluded.image_url,
    updated_at = ${NOW}
    RETURNING name, rss_url, image_url`)
    .bind(name, rss.toString(), image).first<{ name: string; rss_url: string; image_url: string }>();
  // 校验时已经拉过并解析了 RSS：直接入库，首次打开节目不必再拉一遍
  await upsertEpisodes(env, name, feed.episodes.map(episode => ({ ...episode, podcast_name: name })));
  return json({ name: result?.name, rss_url: result?.rss_url, image: result?.image_url ?? "", enabled: true }, 201);
}

export async function deleteSubscription(name: string, env: Env): Promise<Response> {
  const result = await env.db.prepare("DELETE FROM subscriptions WHERE name = ?").bind(decodeURIComponent(name)).run();
  // episodes 通过 FK ON DELETE CASCADE 清理。
  return result.meta.changes ? new Response(null, { status: 204 }) : error(404, "subscription_not_found", "Subscription not found");
}
