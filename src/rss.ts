import { XMLParser } from "fast-xml-parser";

/**
 * RSS 适配层（计划 §8）：在 Worker 里重实现原生 ``RSSParser`` 的**单集归一化**，
 * 以原生 feedparser 输出为测试基线（见 test/fixtures/rss + test/rss.test.ts）。
 * 仅重写数据形状，不改变产品语义。
 */

export interface Episode {
  podcast_name: string;
  title: string;
  link: string;
  audio_url: string;
  published: string; // RSS pubDate 原文
  date: string; // YYYYMMDD（供 build_filename_base 使用）或 UnknownDate
  duration: string; // itunes:duration 原文
  duration_seconds: number;
  summary: string;
  id: string; // guid 优先，回退 link
}

export interface ParsedFeed {
  channelTitle: string;
  channelImage: string;
  episodes: Episode[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  trimValues: false,
  parseTagValue: false,
});

const RE_BR = /<br\s*\/?>/gi;
const RE_P_CLOSE = /<\/p>/gi;
const RE_TAGS = /<[^>]+>/g;

function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object") {
    const record = node as Record<string, unknown>;
    if ("__cdata" in record) return textOf(record.__cdata);
    if ("#text" in record) return textOf(record["#text"]);
  }
  return "";
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// 复刻原生 _parse_duration：HH:MM:SS / MM:SS / 纯秒；无法解析回 0。
export function parseDuration(raw: string): number {
  const value = (raw || "").trim();
  if (!value) return 0;
  if (value.includes(":")) {
    const parts = value.split(":");
    if (parts.length === 3) {
      const [h, m, s] = parts.map(Number);
      if ([h, m, s].every(Number.isFinite)) return h * 3600 + m * 60 + s;
    } else if (parts.length === 2) {
      const [m, s] = parts.map(Number);
      if ([m, s].every(Number.isFinite)) return m * 60 + s;
    }
    return 0;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.trunc(seconds) : 0;
}

// 复刻原生 summary 清洗：<br>→\n、</p>→\n、去标签、trim。
function cleanSummary(raw: string): string {
  return raw
    .replace(RE_BR, "\n")
    .replace(RE_P_CLOSE, "\n")
    .replace(RE_TAGS, "")
    .trim();
}

function pickSummary(item: Record<string, unknown>): string {
  const candidates: string[] = [];
  const encoded = textOf(item["content:encoded"]);
  if (encoded) candidates.push(encoded);
  const description = textOf(item.description);
  if (description) candidates.push(description);
  const summary = textOf(item.summary ?? item["itunes:summary"]);
  if (summary) candidates.push(summary);
  if (!candidates.length) return "";
  // 原生取最长的候选（含完整时间线的 show notes 往往最长）。
  const longest = candidates.reduce((a, b) => (b.length > a.length ? b : a));
  return cleanSummary(longest);
}

function audioUrl(item: Record<string, unknown>): string {
  // RSS enclosure（单个或多个）。
  for (const enclosure of asArray(item.enclosure)) {
    const url = (enclosure as Record<string, unknown>)?.["@_url"];
    if (typeof url === "string" && url) return url;
  }
  // Atom-style <link rel="enclosure"> 或 type 含 audio。
  for (const link of asArray(item.link)) {
    if (typeof link === "object" && link) {
      const record = link as Record<string, unknown>;
      const rel = String(record["@_rel"] ?? "");
      const type = String(record["@_type"] ?? "");
      const href = record["@_href"];
      if ((rel === "enclosure" || type.includes("audio")) && typeof href === "string") return href;
    }
  }
  return "";
}

// pubDate → YYYYMMDD（对齐原生 datetime_to_str 的取值口径）。
function dateFromPubDate(pubDate: string): string {
  const value = (pubDate || "").trim();
  if (!value) return "UnknownDate";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return "UnknownDate";
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function channelImage(channel: Record<string, unknown>): string {
  const itunesImage = channel["itunes:image"];
  if (itunesImage && typeof itunesImage === "object") {
    const href = (itunesImage as Record<string, unknown>)["@_href"];
    if (typeof href === "string" && href) return href;
  }
  const image = channel.image;
  if (image && typeof image === "object") {
    const url = (image as Record<string, unknown>).url;
    if (url) return textOf(url);
  }
  return "";
}

export function parseFeed(xml: string, podcastName: string, minDurationSeconds = 0): ParsedFeed {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = (doc.rss ?? doc) as Record<string, unknown>;
  const channel = (rss.channel ?? {}) as Record<string, unknown>;
  const items = asArray(channel.item);

  const episodes: Episode[] = [];
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    const title = (textOf(item.title) || "Untitled").trim();
    const link = textOf(item.link && typeof item.link !== "object" ? item.link : "") || firstStringLink(item);
    const durationRaw = textOf(item["itunes:duration"]) || "0";
    const durationSeconds = parseDuration(durationRaw);
    if (durationSeconds < minDurationSeconds) continue;
    const url = audioUrl(item);
    if (!url) continue; // 无音频链接的条目跳过（对齐原生）。
    const guid = textOf(item.guid);
    const published = textOf(item.pubDate);
    episodes.push({
      podcast_name: podcastName,
      title,
      link,
      audio_url: url,
      published,
      date: dateFromPubDate(published),
      duration: durationRaw,
      duration_seconds: durationSeconds,
      summary: pickSummary(item),
      id: guid || link,
    });
  }
  return { channelTitle: textOf(channel.title).trim(), channelImage: channelImage(channel), episodes };
}

// <link> 可能是字符串或（Atom）对象数组；取第一个字符串型 href/文本。
function firstStringLink(item: Record<string, unknown>): string {
  for (const link of asArray(item.link)) {
    if (typeof link === "string") return link;
    if (typeof link === "object" && link) {
      const href = (link as Record<string, unknown>)["@_href"];
      if (typeof href === "string") return href;
    }
  }
  return "";
}
