/**
 * Edge 侧精修运行时配置（D1 `refiner_settings`，typed single-row table）。
 *
 * 职责互斥：
 *   转录服务的内建默认值 → 引擎 endpoint / 并发 / 体积上限（不经 Cloudflare 读写）
 *   D1 本表          → Cloudflare 文本管线运行时配置（api_base / model / temperature / max_tokens / min_output_ratio）
 *   repo 源码        → 默认 Prompt 与算法配置（绝不存 D1）
 *   Wrangler Secret  → REFINER_API_KEY（绝不入表）
 */
import { NOW } from "../db";
import { HttpError } from "../http";
import { DEFAULT_REFINER_SETTINGS } from "./defaults";
import type { RefinerConfigSnapshot } from "./refiner";
import type { Env } from "../types";

export interface RefinerSettings extends RefinerConfigSnapshot {
  updatedAt: string | null;
}

interface RefinerSettingsRow {
  api_base: string | null;
  model: string | null;
  temperature: number | null;
  max_tokens: number | null;
  min_output_ratio: number | null;
  updated_at: string | null;
}

function toSettings(row: RefinerSettingsRow | null): RefinerSettings {
  if (!row) return { ...DEFAULT_REFINER_SETTINGS, updatedAt: null };
  return {
    apiBase: (row.api_base ?? "").trim() || DEFAULT_REFINER_SETTINGS.apiBase,
    model: (row.model ?? "").trim() || DEFAULT_REFINER_SETTINGS.model,
    temperature: Number.isFinite(row.temperature) ? Number(row.temperature) : DEFAULT_REFINER_SETTINGS.temperature,
    maxTokens: Number.isFinite(row.max_tokens) && row.max_tokens ? Number(row.max_tokens) : DEFAULT_REFINER_SETTINGS.maxTokens,
    minOutputRatio: Number.isFinite(row.min_output_ratio) ? Number(row.min_output_ratio) : DEFAULT_REFINER_SETTINGS.minOutputRatio,
    updatedAt: row.updated_at ?? null,
  };
}

export async function loadRefinerSettings(env: Env): Promise<RefinerSettings> {
  const row = await env.DB.prepare(
    "SELECT api_base, model, temperature, max_tokens, min_output_ratio, updated_at FROM refiner_settings WHERE id = 1",
  ).first<RefinerSettingsRow>();
  return toSettings(row);
}

/** Workflow 创建时采样配置：任务中途不随 D1 配置漂移（不让任务跑到一半突然切换模型）。 */
export function snapshotOf(settings: RefinerSettings): RefinerConfigSnapshot {
  return {
    apiBase: settings.apiBase,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    minOutputRatio: settings.minOutputRatio,
  };
}

/** 校验并解析 PUT /settings 中 Edge 侧键值（refiner.*）。非法值一律 400，绝不写入半成品。 */
export function parseRefinerSettingsValues(values: Record<string, unknown>): Partial<RefinerConfigSnapshot> {
  const parsed: Partial<RefinerConfigSnapshot> = {};
  for (const [rawKey, rawValue] of Object.entries(values ?? {})) {
    const key = String(rawKey).trim();
    const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
    switch (key) {
      case "refiner.api_base": {
        const text = String(value ?? "").trim();
        if (!/^https?:\/\/\S+$/i.test(text)) {
          throw new HttpError(400, "invalid_settings", "refiner.api_base 必须是 http(s) URL");
        }
        parsed.apiBase = text.replace(/\/+$/, "");
        break;
      }
      case "refiner.model": {
        const text = String(value ?? "").trim();
        if (!text || text.length > 200) {
          throw new HttpError(400, "invalid_settings", "refiner.model 不能为空且不得超过 200 字符");
        }
        parsed.model = text;
        break;
      }
      case "refiner.temperature": {
        const num = Number(value);
        if (!Number.isFinite(num) || num < 0 || num > 2) {
          throw new HttpError(400, "invalid_settings", "refiner.temperature 必须在 0 与 2 之间");
        }
        parsed.temperature = num;
        break;
      }
      case "refiner.max_tokens": {
        const num = Math.trunc(Number(value));
        if (!Number.isFinite(num) || num < 1 || num > 200_000) {
          throw new HttpError(400, "invalid_settings", "refiner.max_tokens 必须在 1 与 200000 之间");
        }
        parsed.maxTokens = num;
        break;
      }
      case "refiner.min_output_ratio": {
        const num = Number(value);
        if (!Number.isFinite(num) || num <= 0 || num > 1) {
          throw new HttpError(400, "invalid_settings", "refiner.min_output_ratio 必须大于 0 且不超过 1");
        }
        parsed.minOutputRatio = num;
        break;
      }
      default:
        // 未知键由上层（putSettings）拒绝；这里忽略。
        break;
    }
  }
  return parsed;
}

export async function updateRefinerSettings(
  env: Env,
  patch: Partial<RefinerConfigSnapshot>,
): Promise<RefinerSettings> {
  const current = await loadRefinerSettings(env);
  const next = {
    apiBase: patch.apiBase ?? current.apiBase,
    model: patch.model ?? current.model,
    temperature: patch.temperature ?? current.temperature,
    maxTokens: patch.maxTokens ?? current.maxTokens,
    minOutputRatio: patch.minOutputRatio ?? current.minOutputRatio,
  };
  await env.DB.prepare(`INSERT INTO refiner_settings (id, api_base, model, temperature, max_tokens, min_output_ratio, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ${NOW})
    ON CONFLICT(id) DO UPDATE SET
      api_base = excluded.api_base,
      model = excluded.model,
      temperature = excluded.temperature,
      max_tokens = excluded.max_tokens,
      min_output_ratio = excluded.min_output_ratio,
      updated_at = excluded.updated_at`)
    .bind(next.apiBase, next.model, next.temperature, next.maxTokens, next.minOutputRatio)
    .run();
  return loadRefinerSettings(env);
}

/** POST /settings/test（target=refiner）——Edge 侧直连服务商探针。 */
export async function testRefinerConnection(
  env: Env,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string; latency_ms?: number }> {
  const settings = await loadRefinerSettings(env);
  const apiBase = settings.apiBase.replace(/\/+$/, "");
  if (!apiBase) return { ok: false, detail: "未配置精修服务商 api_base" };
  if (!env.REFINER_API_KEY) return { ok: false, detail: "未注入 REFINER_API_KEY（Wrangler Secret）" };

  const started = Date.now();
  try {
    const response = await fetchFn(`${apiBase}/models`, {
      headers: { Authorization: `Bearer ${env.REFINER_API_KEY}` },
      signal: AbortSignal.timeout(8_000),
    });
    const latency = Date.now() - started;
    if (response.status === 200) return { ok: true, detail: `精修服务商连接正常 (${latency}ms)`, latency_ms: latency };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: `精修服务商认证失败 (HTTP ${response.status})，请检查 REFINER_API_KEY secret`, latency_ms: latency };
    }
    return { ok: true, detail: `精修服务商网络通畅 (HTTP ${response.status}, ${latency}ms)`, latency_ms: latency };
  } catch (error) {
    return { ok: false, detail: `连接精修服务商失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}
