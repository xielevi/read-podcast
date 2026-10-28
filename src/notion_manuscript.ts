/**
 * Canonical Manuscript Store 的 Notion + R2 实现（Cloudflare，由装配层按开关注入）。
 *
 * - R2 `manuscripts/<sha256>.md` 是不可变发布快照（与本地目录的 `.versions/` 同一思路）。
 *   前缀不参与 raw/refined/uploads 的生命周期过期，对象永久保留。
 * - Notion 数据库「播客转录」是可编辑的正文事实源。页 id 写入 D1 content_path，
 *   sha256 写入 commit_sha。公开页按 commit_sha 读 R2，不读 Notion 的当前正文。
 * - Notion 写入失败不回滚 R2：publish 仍返回成功并带 notionPending，由 runMaintenance 重试。
 * - 版本备份只依赖 Notion 自己的页面历史，没有额外的导出任务。
 *
 * Notion-Version: 2026-03-11。正文走 Markdown API（创建 / replace_content / insert_content）。
 * 超过约 80KB 的正文按段拆开；单段 ≥ 48KB 时 allow_async 并短轮询。Worker 直连
 * api.notion.com（可用 NOTION_API_BASE 改指向）。同区域已有 Worker 能调用 Notion 时，
 * 这里不需要 GitHub 那种 525 中继。
 */
import { sha256Hex } from "./crypto";
import { NOW } from "./db";
import type { ManuscriptPublishInput, ManuscriptPublishMeta, ManuscriptStore, ManuscriptVersion } from "./platform/types";
import type { Env } from "./types";

export const NOTION_VERSION = "2026-03-11";
/** 单次 Markdown 请求的字节上限。约 125KB 的成稿会拆成多段，避免触发 validation_error。 */
export const NOTION_CHUNK_BYTES = 80_000;
/** 达到该大小就走 allow_async，避免同步写超过 Worker 子请求预算。 */
export const NOTION_ASYNC_BYTES = 48_000;
const NOTION_POLL_BUDGET_MS = 30_000;
const NOTION_LIST_PAGES = 10;

export const MANUSCRIPT_R2_PREFIX = "manuscripts/";

export const NOTION_PROPS = {
  title: "标题",
  filename: "文件名",
  show: "节目",
  published: "发布日期",
  duration: "时长",
  audio: "音频链接",
  episodePage: "节目页",
  summary: "导读摘要",
  readingMinutes: "阅读分钟",
  processed: "处理时间",
  transcript: "转录来源",
  refined: "精修成功",
  taskId: "task_id",
  episodeId: "episode_id",
  hash: "内容哈希",
  readingPage: "阅读页",
  status: "状态",
} as const;

const SHOW_OPTIONS = ["忽左忽右", "东腔西调", "知行小酒馆", "naive理想国"] as const;
const TRANSCRIPT_OPTIONS = ["whisper-mlx", "dashscope", "其他"] as const;
const STATUS_OPTIONS = ["已发布", "待复核", "已撤下"] as const;

const PAGE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

export function manuscriptObjectKey(sha256: string): string {
  return `${MANUSCRIPT_R2_PREFIX}${sha256.toLowerCase()}.md`;
}

export function manuscriptMetaKey(sha256: string): string {
  return `${MANUSCRIPT_R2_PREFIX}${sha256.toLowerCase()}.meta.json`;
}

export function isManuscriptObjectKey(path: string): boolean {
  return /^manuscripts\/[0-9a-f]{64}\.md$/i.test(path);
}

export function isNotionPageId(path: string): boolean {
  return PAGE_ID.test(path.trim());
}

/** 显式 true 开启；显式 false 关闭；否则 token 与数据源（或数据库）id 同时存在即开启。 */
export function notionManuscriptStoreEnabled(env: {
  NOTION_MANUSCRIPT_STORE?: string;
  NOTION_TOKEN?: string;
  NOTION_PODCAST_DATA_SOURCE_ID?: string;
  NOTION_PODCAST_DATABASE_ID?: string;
}): boolean {
  const flag = (env.NOTION_MANUSCRIPT_STORE ?? "").trim().toLowerCase();
  if (flag === "false" || flag === "0" || flag === "off" || flag === "no") return false;
  if (flag === "true" || flag === "1" || flag === "on" || flag === "yes") return true;
  const token = (env.NOTION_TOKEN ?? "").trim();
  const dataSource = (env.NOTION_PODCAST_DATA_SOURCE_ID ?? "").trim();
  const database = (env.NOTION_PODCAST_DATABASE_ID ?? "").trim();
  return Boolean(token && (dataSource || database));
}

export function normalizeNotionId(value: string): string {
  const hex = value.replace(/-/g, "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return value.trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** 按段落边界把 Markdown 切成不超过 maxBytes 的片段；没有空行时按字节硬切。 */
export function chunkMarkdown(markdown: string, maxBytes = NOTION_CHUNK_BYTES): string[] {
  if (maxBytes < 1024) throw new Error("Notion markdown chunk size is too small");
  if (utf8ByteLength(markdown) <= maxBytes) return [markdown];
  const chunks: string[] = [];
  let rest = markdown;
  while (rest) {
    if (utf8ByteLength(rest) <= maxBytes) {
      chunks.push(rest);
      break;
    }
    const cut = largestPrefixUnder(rest, maxBytes);
    const paragraph = rest.lastIndexOf("\n\n", cut);
    const line = rest.lastIndexOf("\n", cut);
    let at = cut;
    let skip = 0;
    if (paragraph >= Math.floor(cut * 0.4)) {
      at = paragraph;
      skip = 2;
    } else if (line >= Math.floor(cut * 0.4)) {
      at = line;
      skip = 1;
    }
    const piece = rest.slice(0, at);
    if (!piece) {
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
      continue;
    }
    chunks.push(piece);
    rest = rest.slice(at + skip);
  }
  return chunks.filter(chunk => chunk.length > 0);
}

function largestPrefixUnder(value: string, maxBytes: number): number {
  let low = 1;
  let high = value.length;
  let best = 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (utf8ByteLength(value.slice(0, mid)) <= maxBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export interface ManuscriptSnapshot extends ManuscriptPublishMeta {
  writingFilename: string;
  title: string;
}

/** 从成稿 frontmatter 取出单行标量（brief 是单行 JSON）。不引入 YAML 库。 */
export function parseManuscriptFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line || line.startsWith(" ") || line.startsWith("\t") || line.startsWith("- ")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    out[key] = value;
  }
  return out;
}

export function resolveManuscriptSnapshot(env: Env, input: ManuscriptPublishInput): ManuscriptSnapshot {
  const frontmatter = parseManuscriptFrontmatter(input.markdown);
  const meta = input.meta ?? {};
  const brief = parseBrief(meta.briefSummary ? null : frontmatter.brief);
  const taskId = emptyToNull(meta.taskId);
  return {
    writingFilename: input.writingFilename,
    title: input.title || frontmatter.title || "未命名单集",
    taskId: taskId ?? undefined,
    episodeId: meta.episodeId ?? null,
    podcastName: meta.podcastName || frontmatter.podcast || "",
    publishedAt: meta.publishedAt || frontmatter.date || null,
    durationSeconds: meta.durationSeconds ?? parseDurationSeconds(frontmatter.duration),
    audioUrl: meta.audioUrl || frontmatter.link || null,
    episodePageUrl: meta.episodePageUrl || frontmatter.source_link || null,
    briefSummary: meta.briefSummary || brief?.tldr || null,
    readingMinutes: meta.readingMinutes ?? brief?.reading_minutes ?? null,
    processedAt: meta.processedAt || frontmatter.processed_at || null,
    transcriptSource: meta.transcriptSource || frontmatter.transcript_source || null,
    refinementSuccess: meta.refinementSuccess ?? frontmatter.refinement_success !== "false",
    readingPageUrl: meta.readingPageUrl || readingPage(env, taskId),
    status: meta.status ?? "已发布",
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text || null;
}

function parseBrief(raw: string | null | undefined): { tldr?: string; reading_minutes?: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { tldr?: unknown; reading_minutes?: unknown };
    return {
      tldr: typeof parsed.tldr === "string" ? parsed.tldr : undefined,
      reading_minutes: typeof parsed.reading_minutes === "number" && Number.isFinite(parsed.reading_minutes) ? parsed.reading_minutes : undefined,
    };
  } catch {
    return null;
  }
}

function readingPage(env: Env, taskId: string | null): string | null {
  const origin = (env.MANUSCRIPT_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!origin || !taskId) return null;
  return httpUrl(`${origin}/a/${taskId}`);
}

export function parseDurationSeconds(value: string | null | undefined): number | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(":").map(part => Number(part));
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isInteger(part) || part < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function notionDate(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (iso) return iso[1];
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function httpUrl(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    return new URL(text).toString();
  } catch {
    return null;
  }
}

function showName(podcast: string | undefined): (typeof SHOW_OPTIONS)[number] | "其他" {
  const name = (podcast ?? "").trim();
  return (SHOW_OPTIONS as readonly string[]).includes(name) ? name as (typeof SHOW_OPTIONS)[number] : "其他";
}

function transcriptSource(explicit: string | null | undefined, provider: string | undefined): (typeof TRANSCRIPT_OPTIONS)[number] {
  const value = (explicit ?? "").trim().toLowerCase();
  if (value === "whisper-mlx" || value === "mlx") return "whisper-mlx";
  if (value === "dashscope" || (provider ?? "").trim().toLowerCase() === "dashscope") return "dashscope";
  return "其他";
}

function statusName(value: ManuscriptPublishMeta["status"] | undefined): (typeof STATUS_OPTIONS)[number] {
  return value && (STATUS_OPTIONS as readonly string[]).includes(value) ? value : "已发布";
}

function manuscriptFilename(writingFilename: string): string {
  const stem = writingFilename.trim() || "未命名单集";
  return stem.toLowerCase().endsWith(".md") ? stem : `${stem}.md`;
}

function richText(content: string): { rich_text: Array<{ type: "text"; text: { content: string } }> } | undefined {
  const text = content.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!text) return undefined;
  return { rich_text: [{ type: "text", text: { content: text } }] };
}

function textOf(prop: unknown): string {
  if (!prop || typeof prop !== "object") return "";
  const items = (prop as { rich_text?: Array<{ plain_text?: string; text?: { content?: string } }>; title?: Array<{ plain_text?: string; text?: { content?: string } }> }).rich_text
    ?? (prop as { title?: Array<{ plain_text?: string; text?: { content?: string } }> }).title
    ?? [];
  return items.map(item => item.plain_text ?? item.text?.content ?? "").join("");
}

export function buildNotionProperties(env: Env, snapshot: ManuscriptSnapshot, hash?: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    [NOTION_PROPS.title]: { title: [{ type: "text", text: { content: snapshot.title.trim().slice(0, 2000) || "未命名单集" } }] },
    [NOTION_PROPS.filename]: richText(manuscriptFilename(snapshot.writingFilename)),
    [NOTION_PROPS.show]: { select: { name: showName(snapshot.podcastName) } },
    [NOTION_PROPS.transcript]: { select: { name: transcriptSource(snapshot.transcriptSource, env.TRANSCRIPTION_PROVIDER) } },
    [NOTION_PROPS.refined]: { checkbox: snapshot.refinementSuccess !== false },
    [NOTION_PROPS.status]: { select: { name: statusName(snapshot.status) } },
  };
  const filename = properties[NOTION_PROPS.filename];
  if (!filename) delete properties[NOTION_PROPS.filename];
  const task = richText(snapshot.taskId ?? "");
  if (task) properties[NOTION_PROPS.taskId] = task;
  const episode = richText(snapshot.episodeId ?? "");
  if (episode) properties[NOTION_PROPS.episodeId] = episode;
  const summary = richText(snapshot.briefSummary ?? "");
  if (summary) properties[NOTION_PROPS.summary] = summary;
  const hashProp = hash ? richText(hash) : undefined;
  if (hashProp) properties[NOTION_PROPS.hash] = hashProp;
  const published = notionDate(snapshot.publishedAt);
  if (published) properties[NOTION_PROPS.published] = { date: { start: published } };
  const processed = notionDate(snapshot.processedAt);
  if (processed) properties[NOTION_PROPS.processed] = { date: { start: processed } };
  if (typeof snapshot.durationSeconds === "number" && Number.isFinite(snapshot.durationSeconds)) {
    properties[NOTION_PROPS.duration] = { number: Math.round(snapshot.durationSeconds) };
  }
  if (typeof snapshot.readingMinutes === "number" && Number.isFinite(snapshot.readingMinutes)) {
    properties[NOTION_PROPS.readingMinutes] = { number: Math.round(snapshot.readingMinutes) };
  }
  const audio = httpUrl(snapshot.audioUrl);
  if (audio) properties[NOTION_PROPS.audio] = { url: audio };
  const episodePage = httpUrl(snapshot.episodePageUrl);
  if (episodePage) properties[NOTION_PROPS.episodePage] = { url: episodePage };
  const page = httpUrl(snapshot.readingPageUrl);
  if (page) properties[NOTION_PROPS.readingPage] = { url: page };
  return properties;
}

class NotionRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "NotionRequestError";
    this.status = status;
    this.code = code;
  }
}

function notionApiBase(env: Env): string {
  return (env.NOTION_API_BASE || "https://api.notion.com").replace(/\/+$/, "");
}

function notionHeaders(token: string): Headers {
  return new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "notion-version": NOTION_VERSION,
  });
}

function assertNotionConfigured(env: Env): void {
  if (!(env.NOTION_TOKEN ?? "").trim()) throw new Error("NOTION_TOKEN is not configured");
  if (!(env.NOTION_PODCAST_DATA_SOURCE_ID ?? "").trim() && !(env.NOTION_PODCAST_DATABASE_ID ?? "").trim()) {
    throw new Error("NOTION_PODCAST_DATA_SOURCE_ID is not configured");
  }
}

interface NotionAsyncTask {
  object: "async_task";
  id: string;
  status: string;
  poll_after_seconds?: number;
  result?: { id?: string };
  error?: { message?: string; code?: string; status?: number };
}

function isAsyncTask(value: unknown): value is NotionAsyncTask {
  return Boolean(value && typeof value === "object" && (value as { object?: string }).object === "async_task");
}

async function notionRequest(env: Env, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const token = (env.NOTION_TOKEN ?? "").trim();
  if (!token) throw new Error("NOTION_TOKEN is not configured");
  const response = await fetch(`${notionApiBase(env)}${path}`, {
    method,
    headers: notionHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let parsed: any;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  return { status: response.status, body: parsed ?? (text ? { message: text.slice(0, 300) } : undefined) };
}

async function notion(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  const { status, body: parsed } = await notionRequest(env, method, path, body);
  if (!statusOk(status) && status !== 202) {
    const message = typeof parsed?.message === "string" ? parsed.message : `Notion API returned HTTP ${status}`;
    console.error("Notion API request failed", status, message.slice(0, 300));
    throw new NotionRequestError(status, `Notion API returned HTTP ${status}: ${message.slice(0, 300)}`, parsed?.code);
  }
  if (isAsyncTask(parsed)) return settleTask(env, parsed);
  return parsed;
}

function statusOk(status: number): boolean {
  return status >= 200 && status < 300;
}

async function settleTask(env: Env, task: NotionAsyncTask): Promise<any> {
  let current = task;
  const started = Date.now();
  while (current.status === "queued" || current.status === "running" || current.status === "retrying") {
    if (Date.now() - started > NOTION_POLL_BUDGET_MS) {
      throw new NotionRequestError(202, "Notion async task timed out");
    }
    const hint = Math.min(5, Math.max(0, Number(current.poll_after_seconds ?? 2)));
    if (hint > 0) await new Promise(resolve => setTimeout(resolve, hint * 1000));
    const polled = await notionRequest(env, "GET", `/v1/async_tasks/${encodeURIComponent(current.id)}`);
    if (!statusOk(polled.status) || !isAsyncTask(polled.body)) {
      throw new NotionRequestError(polled.status, "Notion async task poll failed");
    }
    current = polled.body;
  }
  if (current.status === "succeeded") return current.result;
  const message = current.error?.message || "Notion async task failed";
  throw new NotionRequestError(current.error?.status || 400, message, current.error?.code);
}

function wantsAsync(markdown: string): boolean {
  return utf8ByteLength(markdown) >= NOTION_ASYNC_BYTES;
}

function pageIdOf(result: unknown): string {
  const id = result && typeof result === "object" ? (result as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !id.trim()) throw new NotionRequestError(500, "Notion page response has no id");
  return id;
}

async function resolveDataSourceId(env: Env, cache: { id?: string }): Promise<string> {
  if (cache.id) return cache.id;
  const direct = (env.NOTION_PODCAST_DATA_SOURCE_ID ?? "").trim();
  if (direct) {
    cache.id = normalizeNotionId(direct);
    return cache.id;
  }
  const databaseId = normalizeNotionId((env.NOTION_PODCAST_DATABASE_ID ?? "").trim());
  if (!databaseId) throw new Error("NOTION_PODCAST_DATA_SOURCE_ID is not configured");
  const database = await notion(env, "GET", `/v1/databases/${encodeURIComponent(databaseId)}`);
  const id = database?.data_sources?.[0]?.id;
  if (typeof id !== "string" || !id.trim()) throw new NotionRequestError(404, "Notion database has no data source");
  cache.id = normalizeNotionId(id);
  return cache.id;
}

async function findExistingPage(
  env: Env,
  dataSourceId: string,
  snapshot: ManuscriptSnapshot,
): Promise<{ id: string; hash: string } | null> {
  const filters: unknown[] = [];
  if (snapshot.taskId) filters.push({ property: NOTION_PROPS.taskId, rich_text: { equals: snapshot.taskId } });
  if (snapshot.episodeId) filters.push({ property: NOTION_PROPS.episodeId, rich_text: { equals: snapshot.episodeId } });
  if (!filters.length) return null;
  const body = await notion(env, "POST", `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`, {
    filter: filters.length === 1 ? filters[0] : { or: filters },
    page_size: 10,
  });
  const pages = (body?.results ?? []).filter((page: { object?: string; archived?: boolean }) => page.object === "page" && !page.archived);
  const byTask = snapshot.taskId
    ? pages.find((page: { properties?: Record<string, unknown> }) => textOf(page.properties?.[NOTION_PROPS.taskId]) === snapshot.taskId)
    : undefined;
  const chosen = byTask ?? pages[0];
  if (!chosen?.id) return null;
  return { id: String(chosen.id), hash: textOf(chosen.properties?.[NOTION_PROPS.hash]).toLowerCase() };
}

async function writeMarkdown(env: Env, pageId: string, markdown: string, replace: boolean): Promise<void> {
  const chunks = chunkMarkdown(markdown);
  if (replace) {
    await notion(env, "PATCH", `/v1/pages/${encodeURIComponent(pageId)}/markdown`, {
      ...(wantsAsync(chunks[0]) ? { allow_async: true } : {}),
      type: "replace_content",
      replace_content: { new_str: chunks[0] },
    });
    for (const chunk of chunks.slice(1)) await appendMarkdown(env, pageId, chunk);
    return;
  }
  for (const chunk of chunks.slice(1)) await appendMarkdown(env, pageId, chunk);
}

async function appendMarkdown(env: Env, pageId: string, markdown: string): Promise<void> {
  await notion(env, "PATCH", `/v1/pages/${encodeURIComponent(pageId)}/markdown`, {
    ...(wantsAsync(markdown) ? { allow_async: true } : {}),
    type: "insert_content",
    insert_content: { content: markdown, position: { type: "end" } },
  });
}

async function upsertNotionPage(env: Env, cache: { id?: string }, markdown: string, snapshot: ManuscriptSnapshot, hash: string): Promise<string> {
  const dataSourceId = await resolveDataSourceId(env, cache);
  const existing = await findExistingPage(env, dataSourceId, snapshot);
  const properties = buildNotionProperties(env, snapshot, hash);
  if (existing && existing.hash === hash) {
    await notion(env, "PATCH", `/v1/pages/${encodeURIComponent(existing.id)}`, { properties });
    return existing.id;
  }
  if (existing) {
    await writeMarkdown(env, existing.id, markdown, true);
    await notion(env, "PATCH", `/v1/pages/${encodeURIComponent(existing.id)}`, { properties });
    return existing.id;
  }
  const chunks = chunkMarkdown(markdown);
  const created = await notion(env, "POST", "/v1/pages", {
    parent: { data_source_id: dataSourceId },
    properties: buildNotionProperties(env, snapshot),
    markdown: chunks[0],
    ...(wantsAsync(chunks[0]) ? { allow_async: true } : {}),
  });
  const pageId = pageIdOf(created);
  await writeMarkdown(env, pageId, markdown, false);
  await notion(env, "PATCH", `/v1/pages/${encodeURIComponent(pageId)}`, { properties });
  return pageId;
}

/**
 * Notion 页为可编辑事实源，R2 对象为公开页读取的不可变快照。
 * content_path = Notion 页 id（同步失败时退回 R2 key）；commit_sha = sha256。
 */
export function createNotionR2ManuscriptStore(env: Env): ManuscriptStore {
  const cache: { id?: string } = {};
  return {
    async publish(input): Promise<ManuscriptVersion> {
      if (!env.storage) throw new Error("Object store is not configured");
      assertNotionConfigured(env);
      const version = (await sha256Hex(input.markdown)).toLowerCase();
      const key = manuscriptObjectKey(version);
      if (!(await env.storage.head(key))) {
        await env.storage.put(key, input.markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
      }
      const snapshot = resolveManuscriptSnapshot(env, input);
      await env.storage.put(manuscriptMetaKey(version), JSON.stringify(snapshot), {
        httpMetadata: { contentType: "application/json" },
      });
      try {
        const pageId = await upsertNotionPage(env, cache, input.markdown, snapshot, version);
        return { path: pageId, version, notionPending: false };
      } catch (error) {
        if (error instanceof Error && /is not configured/.test(error.message)) throw error;
        console.error("Notion manuscript sync failed; R2 snapshot kept", snapshot.taskId ?? "", error instanceof Error ? error.message : "error");
        return { path: key, version, notionPending: true };
      }
    },

    async read(path, version): Promise<string | null> {
      if (version && SHA256.test(version)) {
        const object = await env.storage.get(manuscriptObjectKey(version));
        return object ? object.text() : null;
      }
      if (isManuscriptObjectKey(path)) {
        const object = await env.storage.get(path);
        return object ? object.text() : null;
      }
      if (!version && isNotionPageId(path)) {
        try {
          const page = await notion(env, "GET", `/v1/pages/${encodeURIComponent(normalizeNotionId(path))}/markdown`);
          return typeof page?.markdown === "string" ? page.markdown : null;
        } catch (error) {
          if (error instanceof NotionRequestError && (error.status === 404 || error.code === "object_not_found")) return null;
          throw error;
        }
      }
      return null;
    },

    async list(): Promise<Array<{ path: string; version: string }>> {
      const dataSourceId = await resolveDataSourceId(env, cache);
      const pages: Array<{ path: string; version: string }> = [];
      let cursor: string | undefined;
      for (let page = 0; page < NOTION_LIST_PAGES; page += 1) {
        const body = await notion(env, "POST", `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`, {
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
          filter: { property: NOTION_PROPS.status, select: { equals: "已发布" } },
        });
        for (const item of body?.results ?? []) {
          if (item.object !== "page" || item.archived || typeof item.id !== "string") continue;
          pages.push({ path: item.id, version: textOf(item.properties?.[NOTION_PROPS.hash]).toLowerCase() });
        }
        if (!body?.has_more || typeof body.next_cursor !== "string" || !body.next_cursor) break;
        cursor = body.next_cursor;
      }
      return pages.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}

interface PendingArticle {
  task_id: string;
  episode_id: string | null;
  title: string;
  podcast_name: string;
  content_path: string;
  commit_sha: string;
  brief: string | null;
  audio_url: string | null;
}

/**
 * 重试 notion_sync_pending = 1 的稿件。未开启 Notion store 时立即返回 0，
 * 因此 GitHub 部署与历史行都不会被导入。
 */
export async function retryPendingNotionManuscripts(env: Env, limit = 3): Promise<number> {
  if (!notionManuscriptStoreEnabled(env)) return 0;
  const pending = await env.db.prepare(
    `SELECT a.task_id, a.episode_id, a.title, a.podcast_name, a.content_path, a.commit_sha, a.brief, t.audio_url
     FROM articles a JOIN tasks t ON t.id = a.task_id
     WHERE a.notion_sync_pending = 1
     ORDER BY a.updated_at ASC
     LIMIT ?`,
  ).bind(limit).all<PendingArticle>();

  const cache: { id?: string } = {};
  let synced = 0;
  for (const row of pending.results) {
    const version = (row.commit_sha ?? "").toLowerCase();
    if (!SHA256.test(version)) continue;
    try {
      const object = await env.storage.get(manuscriptObjectKey(version));
      if (!object) {
        console.error("Notion retry skipped; R2 snapshot missing", row.task_id);
        continue;
      }
      const markdown = await object.text();
      const sidecar = await readSidecar(env, version);
      const brief = parseStoredBriefSummary(row.brief);
      const snapshot = sidecar ?? resolveManuscriptSnapshot(env, {
        writingFilename: row.title,
        title: row.title,
        markdown,
        meta: {
          taskId: row.task_id,
          episodeId: row.episode_id,
          podcastName: row.podcast_name,
          audioUrl: row.audio_url,
          briefSummary: brief.summary,
          readingMinutes: brief.minutes,
        },
      });
      snapshot.taskId = row.task_id;
      snapshot.episodeId = snapshot.episodeId ?? row.episode_id;
      const pageId = await upsertNotionPage(env, cache, markdown, snapshot, version);
      const previousPath = row.content_path;
      await env.db.batch([
        env.db.prepare(
          `UPDATE articles SET content_path = ?, notion_sync_pending = 0, notion_synced_at = ${NOW}
           WHERE task_id = ? AND commit_sha = ? AND notion_sync_pending = 1`,
        ).bind(pageId, row.task_id, row.commit_sha),
        env.db.prepare(
          `UPDATE tasks SET final_content_path = ? WHERE id = ? AND content_commit_sha = ?`,
        ).bind(pageId, row.task_id, row.commit_sha),
        env.db.prepare(
          `UPDATE article_concepts SET content_path = ? WHERE content_path = ? AND commit_sha = ?`,
        ).bind(pageId, previousPath, row.commit_sha),
      ]);
      synced += 1;
    } catch (error) {
      console.error("Notion manuscript retry failed", row.task_id, error instanceof Error ? error.message : "error");
    }
  }
  return synced;
}

async function readSidecar(env: Env, version: string): Promise<ManuscriptSnapshot | null> {
  const object = await env.storage.get(manuscriptMetaKey(version));
  if (!object) return null;
  try {
    const parsed = JSON.parse(await object.text()) as ManuscriptSnapshot;
    if (!parsed || typeof parsed !== "object" || typeof parsed.title !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseStoredBriefSummary(raw: string | null): { summary: string | null; minutes: number | null } {
  const brief = parseBrief(raw);
  return { summary: brief?.tldr ?? null, minutes: brief?.reading_minutes ?? null };
}
