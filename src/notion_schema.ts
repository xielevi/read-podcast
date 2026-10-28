/**
 * Notion 数据库字段映射。逻辑字段是固定的；Notion 上的显示名由推荐模板或配置给出。
 *
 * 必填逻辑字段：title、taskId、episodeId、hash、status。
 * 其余为空字符串时跳过，不写入。
 *
 * `NOTION_SCHEMA=zh`（默认）或 `en` 选用推荐模板。运算符用 `NOTION_SCHEMA_JSON` /
 * `NOTION_PROPERTY_MAP` / `NOTION_SHOW_OPTIONS` 覆盖，不必使用中文名。
 */

export const NOTION_PROPERTY_KEYS = [
  "title",
  "filename",
  "show",
  "published",
  "duration",
  "audio",
  "episodePage",
  "summary",
  "readingMinutes",
  "processed",
  "transcript",
  "refined",
  "taskId",
  "episodeId",
  "hash",
  "readingPage",
  "status",
] as const;

export type NotionPropertyKey = (typeof NOTION_PROPERTY_KEYS)[number];

export const REQUIRED_NOTION_PROPERTIES: readonly NotionPropertyKey[] = [
  "title",
  "taskId",
  "episodeId",
  "hash",
  "status",
];

export interface NotionSchema {
  properties: Record<NotionPropertyKey, string>;
  status: { published: string; review: string; withdrawn: string };
  transcript: { "whisper-mlx": string; dashscope: string; other: string };
  shows: string[];
  showOther: string;
}

/** 推荐中文模板。运算符需在 Notion 里建出同名属性；不是唯一支持的形状。 */
export const NOTION_SCHEMA_ZH: NotionSchema = {
  properties: {
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
  },
  status: { published: "已发布", review: "待复核", withdrawn: "已撤下" },
  transcript: { "whisper-mlx": "whisper-mlx", dashscope: "dashscope", other: "其他" },
  shows: [],
  showOther: "其他",
};

/** 推荐英文模板。 */
export const NOTION_SCHEMA_EN: NotionSchema = {
  properties: {
    title: "Title",
    filename: "Filename",
    show: "Show",
    published: "Published",
    duration: "Duration",
    audio: "Audio",
    episodePage: "Episode page",
    summary: "Brief",
    readingMinutes: "Reading minutes",
    processed: "Processed",
    transcript: "Transcript source",
    refined: "Refined",
    taskId: "task_id",
    episodeId: "episode_id",
    hash: "content_hash",
    readingPage: "Reading page",
    status: "Status",
  },
  status: { published: "Published", review: "In review", withdrawn: "Withdrawn" },
  transcript: { "whisper-mlx": "whisper-mlx", dashscope: "dashscope", other: "Other" },
  shows: [],
  showOther: "Other",
};

export const NOTION_SCHEMA_TEMPLATES = { zh: NOTION_SCHEMA_ZH, en: NOTION_SCHEMA_EN } as const;

export interface NotionSchemaEnv {
  NOTION_SCHEMA?: string;
  NOTION_SCHEMA_JSON?: string;
  NOTION_PROPERTY_MAP?: string;
  NOTION_SHOW_OPTIONS?: string;
  NOTION_SHOW_OTHER?: string;
  NOTION_STATUS_VALUES?: string;
  NOTION_TRANSCRIPT_VALUES?: string;
}

function cloneSchema(schema: NotionSchema): NotionSchema {
  return {
    properties: { ...schema.properties },
    status: { ...schema.status },
    transcript: { ...schema.transcript },
    shows: [...schema.shows],
    showOther: schema.showOther,
  };
}

function parseJson(value: string | undefined, label: string): Record<string, unknown> | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`);
  }
}

function applyPropertyMap(schema: NotionSchema, map: Record<string, unknown> | null): void {
  if (!map) return;
  for (const key of NOTION_PROPERTY_KEYS) {
    if (!(key in map)) continue;
    const value = map[key];
    schema.properties[key] = value == null ? "" : String(value);
  }
}

function applyStringMap(target: Record<string, string>, map: Record<string, unknown> | null): void {
  if (!map) return;
  for (const key of Object.keys(target)) {
    if (!(key in map) || map[key] == null) continue;
    target[key] = String(map[key]);
  }
}

export function resolveNotionSchema(env: NotionSchemaEnv = {}): NotionSchema {
  const name = (env.NOTION_SCHEMA ?? "zh").trim().toLowerCase();
  const template = name === "en" ? NOTION_SCHEMA_EN : NOTION_SCHEMA_ZH;
  const schema = cloneSchema(template);

  const overlay = parseJson(env.NOTION_SCHEMA_JSON, "NOTION_SCHEMA_JSON");
  if (overlay) {
    if (overlay.properties && typeof overlay.properties === "object") {
      applyPropertyMap(schema, overlay.properties as Record<string, unknown>);
    }
    if (overlay.status && typeof overlay.status === "object") {
      applyStringMap(schema.status, overlay.status as Record<string, unknown>);
    }
    if (overlay.transcript && typeof overlay.transcript === "object") {
      applyStringMap(schema.transcript, overlay.transcript as Record<string, unknown>);
    }
    if (typeof overlay.showOther === "string" && overlay.showOther.trim()) schema.showOther = overlay.showOther.trim();
    if (Array.isArray(overlay.shows)) {
      schema.shows = overlay.shows.map(item => String(item).trim()).filter(Boolean);
    }
  }

  applyPropertyMap(schema, parseJson(env.NOTION_PROPERTY_MAP, "NOTION_PROPERTY_MAP"));
  applyStringMap(schema.status, parseJson(env.NOTION_STATUS_VALUES, "NOTION_STATUS_VALUES"));
  applyStringMap(schema.transcript, parseJson(env.NOTION_TRANSCRIPT_VALUES, "NOTION_TRANSCRIPT_VALUES"));

  const shows = (env.NOTION_SHOW_OPTIONS ?? "").split(",").map(item => item.trim()).filter(Boolean);
  if (shows.length) schema.shows = shows;
  const other = (env.NOTION_SHOW_OTHER ?? "").trim();
  if (other) schema.showOther = other;

  const missing = REQUIRED_NOTION_PROPERTIES.filter(key => !schema.properties[key].trim());
  if (missing.length) {
    throw new Error(`Notion schema is missing required property names: ${missing.join(", ")}`);
  }
  return schema;
}

export function notionPropertyName(schema: NotionSchema, key: NotionPropertyKey): string {
  return schema.properties[key].trim();
}
