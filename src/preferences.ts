/**
 * 云端 UI 与阅读偏好管理（D1 `ui_preferences`，typed single-row table）。
 *
 * 职责：
 *   - D1 作为用户外观与阅读器排版的单一真源（Single Source of Truth）；
 *   - 客户端零本地持久化配置，避免不同设备与浏览器 localStorage 割裂；
 *   - 公共阅读面只读获取（无副作用），控制面支持校验写入。
 */
import { NOW } from "./db";
import { HttpError, json, readJson } from "./http";
import type { Env } from "./types";

export type AppTheme = "auto" | "light" | "dark";
export type ReaderTheme = "follow" | "paper" | "warm" | "green" | "dark";
export type FontPreset = "classical" | "modern";
export type LineHeight = "compact" | "normal" | "relaxed";
export type MarginWidth = "compact" | "normal" | "wide";

export interface UiPreferences {
  appTheme: AppTheme;
  readerTheme: ReaderTheme;
  fontPreset: FontPreset;
  fontSize: number;
  lineHeight: LineHeight;
  marginWidth: MarginWidth;
  updatedAt: string | null;
}

export interface UiPreferencesDto {
  app_theme: AppTheme;
  reader_theme: ReaderTheme;
  font_preset: FontPreset;
  font_size: number;
  line_height: LineHeight;
  margin_width: MarginWidth;
  updated_at: string | null;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  appTheme: "auto",
  readerTheme: "follow",
  fontPreset: "classical",
  fontSize: 19,
  lineHeight: "normal",
  marginWidth: "normal",
  updatedAt: null,
};

interface UiPreferencesRow {
  app_theme: string | null;
  reader_theme: string | null;
  font_preset: string | null;
  font_size: number | null;
  line_height: string | null;
  margin_width: string | null;
  updated_at: string | null;
}

const VALID_APP_THEMES = new Set<string>(["auto", "light", "dark"]);
const VALID_READER_THEMES = new Set<string>(["follow", "paper", "warm", "green", "dark"]);
const VALID_FONT_PRESETS = new Set<string>(["classical", "modern"]);
const VALID_LINE_HEIGHTS = new Set<string>(["compact", "normal", "relaxed"]);
const VALID_MARGIN_WIDTHS = new Set<string>(["compact", "normal", "wide"]);

function toPreferences(row: UiPreferencesRow | null): UiPreferences {
  if (!row) return { ...DEFAULT_UI_PREFERENCES };
  return {
    appTheme: VALID_APP_THEMES.has(row.app_theme ?? "") ? (row.app_theme as AppTheme) : DEFAULT_UI_PREFERENCES.appTheme,
    readerTheme: VALID_READER_THEMES.has(row.reader_theme ?? "") ? (row.reader_theme as ReaderTheme) : DEFAULT_UI_PREFERENCES.readerTheme,
    fontPreset: VALID_FONT_PRESETS.has(row.font_preset ?? "") ? (row.font_preset as FontPreset) : DEFAULT_UI_PREFERENCES.fontPreset,
    fontSize: Number.isInteger(row.font_size) && (row.font_size ?? 0) >= 12 && (row.font_size ?? 0) <= 36
      ? (row.font_size as number)
      : DEFAULT_UI_PREFERENCES.fontSize,
    lineHeight: VALID_LINE_HEIGHTS.has(row.line_height ?? "") ? (row.line_height as LineHeight) : DEFAULT_UI_PREFERENCES.lineHeight,
    marginWidth: VALID_MARGIN_WIDTHS.has(row.margin_width ?? "") ? (row.margin_width as MarginWidth) : DEFAULT_UI_PREFERENCES.marginWidth,
    updatedAt: row.updated_at ?? null,
  };
}

export function toPreferencesDto(prefs: UiPreferences): UiPreferencesDto {
  return {
    app_theme: prefs.appTheme,
    reader_theme: prefs.readerTheme,
    font_preset: prefs.fontPreset,
    font_size: prefs.fontSize,
    line_height: prefs.lineHeight,
    margin_width: prefs.marginWidth,
    updated_at: prefs.updatedAt,
  };
}

export async function loadUiPreferences(env: Env): Promise<UiPreferences> {
  const row = await env.db.prepare(
    "SELECT app_theme, reader_theme, font_preset, font_size, line_height, margin_width, updated_at FROM ui_preferences WHERE id = 1",
  ).first<UiPreferencesRow>();
  return toPreferences(row);
}

export function parseUiPreferencesPatch(body: unknown): Partial<Omit<UiPreferences, "updatedAt">> {
  if (typeof body !== "object" || body === null) {
    throw new HttpError(400, "invalid_preferences", "Preferences body must be an object");
  }
  const raw = body as Record<string, unknown>;
  const patch: Partial<Omit<UiPreferences, "updatedAt">> = {};

  if (raw.app_theme !== undefined) {
    const val = String(raw.app_theme).trim();
    if (!VALID_APP_THEMES.has(val)) {
      throw new HttpError(400, "invalid_preferences", "app_theme 必须是 auto、light 或 dark");
    }
    patch.appTheme = val as AppTheme;
  }

  if (raw.reader_theme !== undefined) {
    const val = String(raw.reader_theme).trim();
    if (!VALID_READER_THEMES.has(val)) {
      throw new HttpError(400, "invalid_preferences", "reader_theme 必须是 follow、paper、warm、green 或 dark");
    }
    patch.readerTheme = val as ReaderTheme;
  }

  if (raw.font_preset !== undefined) {
    const val = String(raw.font_preset).trim();
    if (!VALID_FONT_PRESETS.has(val)) {
      throw new HttpError(400, "invalid_preferences", "font_preset 必须是 classical 或 modern");
    }
    patch.fontPreset = val as FontPreset;
  }

  if (raw.font_size !== undefined) {
    const num = Math.trunc(Number(raw.font_size));
    if (!Number.isFinite(num) || num < 12 || num > 36) {
      throw new HttpError(400, "invalid_preferences", "font_size 必须在 12 到 36 之间");
    }
    patch.fontSize = num;
  }

  if (raw.line_height !== undefined) {
    const val = String(raw.line_height).trim();
    if (!VALID_LINE_HEIGHTS.has(val)) {
      throw new HttpError(400, "invalid_preferences", "line_height 必须是 compact、normal 或 relaxed");
    }
    patch.lineHeight = val as LineHeight;
  }

  if (raw.margin_width !== undefined) {
    const val = String(raw.margin_width).trim();
    if (!VALID_MARGIN_WIDTHS.has(val)) {
      throw new HttpError(400, "invalid_preferences", "margin_width 必须是 compact、normal 或 wide");
    }
    patch.marginWidth = val as MarginWidth;
  }

  return patch;
}

export async function updateUiPreferences(
  env: Env,
  patch: Partial<Omit<UiPreferences, "updatedAt">>,
): Promise<UiPreferences> {
  const current = await loadUiPreferences(env);
  const next: UiPreferences = {
    appTheme: patch.appTheme ?? current.appTheme,
    readerTheme: patch.readerTheme ?? current.readerTheme,
    fontPreset: patch.fontPreset ?? current.fontPreset,
    fontSize: patch.fontSize ?? current.fontSize,
    lineHeight: patch.lineHeight ?? current.lineHeight,
    marginWidth: patch.marginWidth ?? current.marginWidth,
    updatedAt: null,
  };

  await env.db.prepare(`INSERT INTO ui_preferences (id, app_theme, reader_theme, font_preset, font_size, line_height, margin_width, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ${NOW})
    ON CONFLICT(id) DO UPDATE SET
      app_theme = excluded.app_theme,
      reader_theme = excluded.reader_theme,
      font_preset = excluded.font_preset,
      font_size = excluded.font_size,
      line_height = excluded.line_height,
      margin_width = excluded.margin_width,
      updated_at = excluded.updated_at`)
    .bind(next.appTheme, next.readerTheme, next.fontPreset, next.fontSize, next.lineHeight, next.marginWidth)
    .run();

  return loadUiPreferences(env);
}

/** GET /api/public/preferences —— 只读拉取云端默认 UI 与排版配置。 */
export async function getPublicPreferences(env: Env): Promise<Response> {
  const prefs = await loadUiPreferences(env);
  return json(toPreferencesDto(prefs));
}

/** GET /api/control/preferences —— 控制面拉取云端偏好。 */
export async function getControlPreferences(env: Env): Promise<Response> {
  const prefs = await loadUiPreferences(env);
  return json(toPreferencesDto(prefs));
}

/** PUT /api/control/preferences —— 控制面更新云端偏好。 */
export async function putControlPreferences(request: Request, env: Env): Promise<Response> {
  const body = await readJson<unknown>(request);
  const patch = parseUiPreferencesPatch(body);
  const updated = await updateUiPreferences(env, patch);
  return json(toPreferencesDto(updated));
}
