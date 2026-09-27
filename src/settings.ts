import { HttpError, error, json, readJson } from "./http";
import { checkServiceHealth } from "./transcription/client";
import {
  loadRefinerSettings,
  parseRefinerSettingsValues,
  testRefinerConnection,
  updateRefinerSettings,
  type RefinerSettings,
} from "./refinement/settings";
import type { Env } from "./types";

/**
 * Settings ownership：
 *   Cloudflare 拥有全部可编辑配置：
 *     - refiner.*（api_base / model / temperature / max_tokens / min_output_ratio，保存在 D1）；
 *     - REFINER_API_KEY 由 Wrangler Secret 管理，不在设置面板中回传。
 *   转录服务的 endpoint 与 Cloudflare Access service token 均为 Cloudflare 环境变量/凭据；
 *   转录服务本机为零配置计算节点，无应用层持久化状态。
 */

interface SettingsGroup {
  key: string;
  title: string;
  description?: string;
  fields: Array<Record<string, unknown>>;
}

const EDGE_REFINER_KEYS = new Set([
  "refiner.api_base",
  "refiner.model",
  "refiner.temperature",
  "refiner.max_tokens",
  "refiner.min_output_ratio",
]);

function edgeGroups(settings: RefinerSettings): SettingsGroup[] {
  return [
    {
      key: "refiner",
      title: "文字整理",
      fields: [
        {
          key: "refiner.model",
          label: "模型",
          type: "text",
          placeholder: "服务商提供的模型 ID",
          value: settings.model,
        },
        {
          key: "refiner.api_base",
          label: "服务地址",
          type: "text",
          placeholder: "https://api.example.com/v1",
          value: settings.apiBase,
        },
        {
          key: "refiner.temperature",
          label: "创作温度",
          type: "text",
          placeholder: "0.3",
          value: String(settings.temperature),
        },
        {
          key: "refiner.max_tokens",
          label: "最大输出",
          type: "text",
          placeholder: "65536",
          value: String(settings.maxTokens),
        },
      ],
    },
    {
      key: "quality",
      title: "完整度保护",
      description: "成稿明显过短时不会发布。",
      fields: [
        {
          key: "refiner.min_output_ratio",
          label: "完整度保护",
          type: "text",
          placeholder: "0.7",
          value: String(settings.minOutputRatio),
          hint: "这是发布硬下限；默认 Prompt 的编辑目标约为原始转录的 80%。",
        },
      ],
    },
  ];
}

async function aggregatedSettings(env: Env): Promise<Record<string, unknown>> {
  const settings = await loadRefinerSettings(env);
  const groups: SettingsGroup[] = edgeGroups(settings);
  return { writable: true, groups };
}

export async function getSettings(env: Env): Promise<Response> {
  return json(await aggregatedSettings(env));
}

export async function putSettings(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ values?: Record<string, unknown> }>(request);
  const values = body.values && typeof body.values === "object" ? body.values : {};

  const edgeValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!EDGE_REFINER_KEYS.has(key)) {
      throw new HttpError(400, "unsupported_setting", `配置项 ${key} 不由 Cloudflare 管理`);
    }
    edgeValues[key] = value;
  }

  // 精修配置随时可改（进行中的任务使用创建时的配置快照）。
  if (Object.keys(edgeValues).length) {
    const patch = parseRefinerSettingsValues(edgeValues);
    if (Object.keys(patch).length) await updateRefinerSettings(env, patch);
  }

  return json(await aggregatedSettings(env));
}

export async function testSettings(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ target?: string }>(request);
  const target = (body.target ?? "").trim();
  if (target !== "transcription" && target !== "refiner") {
    throw new HttpError(400, "invalid_target", "Target must be 'transcription' or 'refiner'");
  }

  if (target === "refiner") {
    // 在 Cloudflare 侧直连服务商探针。
    const result = await testRefinerConnection(env);
    return json(result);
  }

  const health = await checkServiceHealth(env);
  if (!health.ok) return error(502, "transcription_service_unreachable", health.detail);
  return json({ ok: true, detail: health.detail, latency_ms: health.latencyMs });
}
