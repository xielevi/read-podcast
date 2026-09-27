import { MAX_UPLOAD_BYTES } from "../limits";
import { checkPublicHttpUrl, type UrlRejection } from "../net/url_guard";
import { transcriptionProvider } from "./client";
import {
  PRESIGNED_SOURCE_TTL_SECONDS,
  R2PresignError,
  presignR2Get,
  type R2SigningCredentials,
} from "./r2_presign";
import type { TranscriptionSource } from "./contract";
import type { Env } from "../types";

/**
 * 音频 source：转录服务看到的统一概念只有「一个可取回的 URL」。
 *
 * - 普通 RSS 单集：直接给公网音频 URL（服务端负责 SSRF 安全的抓取——逐跳复核重定向、拒绝私网）；
 * - 自定义上传（R2）：Cloudflare 针对**那个确切的 object key** 签发一张临时 presigned GET URL。
 *   转录服务不持有任何 R2 / Cloudflare 凭据，也不经 Cloudflare Worker 中转音频：
 *
 *     RSS:            Cloudflare ──source.url = 公网音频 URL──▶ Transcription Service ──▶ podcast CDN
 *     Custom upload:  Cloudflare ──source.url = R2 presigned GET──▶ Transcription Service ──▶ R2 (S3 endpoint)
 *
 * 两张 URL 在转录服务眼里没有任何区别：它只做「GET 这个 URL，存成本地临时文件」。因此不存在
 * 「另一条音频授权链路」——授权机制是 URL 本身（限 GET、限单个 object、限时）。
 *
 * 生命周期属于 **submission**，不属于 HTTP attempt：同一 submission 内 URL 必须稳定（由 Workflow 的
 * `resolve-source-N` durable step 提供），详见 workflows/transcription.ts。
 */

/**
 * 音频源无法用于转录。`code` 是稳定的机器可读原因，由 Cloudflare 原样写成任务错误码。
 *
 * - source_not_allowed         ：URL 不合规（非 http(s) / 含凭据 / 指向私网）
 * - upload_expired             ：上传的临时音频已不存在（会被清理，也可能已过期）
 * - source_too_large           ：对象超过 200 MiB 产品硬上限
 * - r2_credentials_unconfigured：Cloudflare 侧没有配置签发 presigned URL 所需的最小权限 R2 凭据
 */
export type SourceErrorCode = "source_not_allowed" | "upload_expired" | "source_too_large" | "r2_credentials_unconfigured";

export class SourceError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

// ── 公网 URL 预检（防御纵深；权威的 SSRF 拦截在转录服务的抓取层，它能解析 DNS） ──

const AUDIO_URL_REJECTIONS: Record<UrlRejection, string> = {
  invalid: "audio URL is not a valid URL",
  protocol: "audio URL must be http(s)",
  credentials: "audio URL must not contain credentials",
  non_public_host: "audio URL points to a local, private or reserved host",
};

/** 只放行 http(s) 公网 URL 的字面量层面检查（规则见 net/url_guard）。返回规范化后的 URL。 */
export function assertPublicAudioUrl(raw: string): string {
  const checked = checkPublicHttpUrl(raw);
  if (!checked.ok) throw new SourceError("source_not_allowed", AUDIO_URL_REJECTIONS[checked.reason]);
  return checked.url.toString();
}

// ── 跟随跳转拿到最终音频地址（云端服务商路径专用） ──

/** 播客统计跳转普遍存在，但真实音频只隔 1–2 跳；5 跳仍未落定按 URL 不合规处理。 */
const MAX_AUDIO_REDIRECTS = 5;
const AUDIO_REDIRECT_TIMEOUT_MS = 10_000;

/**
 * 沿 3xx 跳转找到最终音频 URL，每一跳都做公网预检（与自托管抓取层的逐跳复核同一防线）。
 *
 * 请求用 `redirect: "manual"` 逐跳进行；落定的响应（非 3xx）**立刻取消 body**——Worker 只取
 * 跳转链与响应头，绝不读取音频字节（音频不经过 Worker 的边界在这里保持）。落定响应的状态码
 * 不在这里判断：可达性由服务商抓取时报告（云端路径的 provider_fetch_failed），
 * 与自托管路径的 source_fetch_failed 同构。
 *
 * 传输错误原样上抛（durable retry 会重试）；跳转链耗尽 / 私网跳转是确定性失败（SourceError）。
 */
export async function resolveFinalAudioUrl(url: string, fetchFn: typeof fetch = fetch): Promise<string> {
  let current = url;
  for (let hop = 0; ; hop += 1) {
    const response = await fetchFn(current, { redirect: "manual", signal: AbortSignal.timeout(AUDIO_REDIRECT_TIMEOUT_MS) });
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 300 || response.status >= 400) return current;
    if (hop >= MAX_AUDIO_REDIRECTS) {
      throw new SourceError("source_not_allowed", `audio URL did not settle after ${MAX_AUDIO_REDIRECTS} redirects`);
    }
    const location = response.headers.get("location");
    if (!location) return current;
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new SourceError("source_not_allowed", "audio URL redirect location is not a valid URL");
    }
    current = assertPublicAudioUrl(next);
  }
}

// ── 上传音频的确切 object key ──

const UPLOAD_KEY_ROOT = "uploads/";

/**
 * 从 `tasks.audio_url` 解析出**确切的** R2 object key（`r2://uploads/<upload_id>/<filename>`）。
 *
 * 刻意不做「prefix + list(limit:1)」这种模糊查找：那会把「目录下碰巧排第一的对象」当成长期身份，
 * 一旦同一 upload_id 下出现第二个对象，身份就不再确定。任务的 source 必须指向唯一确定的 key。
 *
 * 只接受恰好三段（`uploads` + 单段 upload_id + 单段文件名）；缺段、多段、空段、上跳一律返回 ""
 * （调用方按 upload_expired 处理）。文件名里的 `/` 会被 `sanitizeFilename` 替换掉，所以正常写入的
 * key 一定是这个形状。
 */
export function uploadObjectKeyFromAudioUrl(audioUrl: string | null): string {
  const raw = (audioUrl ?? "").trim();
  if (!raw.startsWith(`r2://${UPLOAD_KEY_ROOT}`)) return "";
  const key = raw.slice("r2://".length);
  const segments = key.split("/");
  if (segments.length !== 3) return "";
  const [, uploadId, filename] = segments;
  if (!uploadId || uploadId === "." || uploadId === "..") return "";
  if (!filename || filename === "." || filename === "..") return "";
  return key;
}

/**
 * 上传的 upload_id（用于在 raw 落库后清理临时音频，以及 retry 前检查原音频是否还在）。
 *
 * 比 `uploadObjectKeyFromAudioUrl` 宽松：清理只需要 upload_id 这一段，不关心对象形状——
 * 所以历史 / 异常引用也能被清掉，而不是留下孤儿对象。
 */
export function uploadIdFromAudioUrl(audioUrl: string | null): string {
  const raw = (audioUrl ?? "").trim();
  if (!raw.startsWith(`r2://${UPLOAD_KEY_ROOT}`)) return "";
  const segments = raw.slice("r2://".length).split("/");
  return segments.length >= 2 ? segments[1] : "";
}

// ── 最小权限的 R2 签发凭据（Cloudflare secret；转录服务永远不持有） ──

const R2_CREDENTIAL_FIELDS = [
  ["accountId", "R2_ACCOUNT_ID"],
  ["accessKeyId", "R2_ACCESS_KEY_ID"],
  ["secretAccessKey", "R2_SECRET_ACCESS_KEY"],
  ["bucket", "R2_BUCKET_NAME"],
] as const;

export function r2Credentials(env: Env): R2SigningCredentials {
  const credentials: R2SigningCredentials = {
    accountId: (env.R2_ACCOUNT_ID ?? "").trim(),
    accessKeyId: (env.R2_ACCESS_KEY_ID ?? "").trim(),
    secretAccessKey: (env.R2_SECRET_ACCESS_KEY ?? "").trim(),
    bucket: (env.R2_BUCKET_NAME ?? "").trim(),
  };
  const missing = R2_CREDENTIAL_FIELDS.filter(([field]) => !credentials[field]).map(([, name]) => name);
  if (missing.length) {
    throw new SourceError("r2_credentials_unconfigured", `presigning an upload source requires ${missing.join(" / ")}`);
  }
  return credentials;
}

// ── 任务 → source ──

export interface SourceTask {
  source_type: "rss" | "upload";
  audio_url: string | null;
}

/**
 * 解析一次 submission 的 source descriptor。
 *
 * 调用方（Workflow 的 `resolve-source-N` durable step）负责让结果**只算一次**：同一 submission 的
 * 任何 retry 都复用这个结果，因此同一 request_id 永远不会因为 URL 变化而触发 409 request_conflict。
 *
 * 云端服务商路径（dashscope）下，RSS 公网地址先跟随跳转拿到最终 URL 再交给服务商
 * （统计跳转 / 防盗链地址服务商通常取不到）；presigned URL 本身就是最终地址，不需要解析。
 */
export async function resolveTranscriptionSource(
  env: Env,
  task: SourceTask,
  nowMs: number = Date.now(),
  ttlSeconds: number = PRESIGNED_SOURCE_TTL_SECONDS,
  fetchFn: typeof fetch = fetch,
): Promise<TranscriptionSource> {
  if (task.source_type !== "upload") {
    const url = assertPublicAudioUrl(task.audio_url ?? "");
    if (transcriptionProvider(env) === "dashscope") return { type: "url", url: await resolveFinalAudioUrl(url, fetchFn) };
    return { type: "url", url };
  }

  const key = uploadObjectKeyFromAudioUrl(task.audio_url);
  if (!key) throw new SourceError("upload_expired", "uploaded audio reference is missing or malformed");

  // 以存储里的真实对象为准：存在 + 不超过产品硬上限。超限的对象在**签名之前**就拒绝，
  // 绝不为一个不可能被处理的对象签发 URL。
  const object = await env.storage.head(key);
  if (!object) throw new SourceError("upload_expired", "uploaded audio is missing or has expired");
  if (object.size > MAX_UPLOAD_BYTES) throw new SourceError("source_too_large", "uploaded audio exceeds the product hard cap");

  let url: string;
  try {
    if (env.storage.createPresignedUrl) {
      url = await env.storage.createPresignedUrl(key, { nowMs, expiresInSeconds: ttlSeconds });
    } else {
      url = await presignR2Get(r2Credentials(env), key, nowMs, ttlSeconds);
    }
  } catch (error) {
    if (error instanceof R2PresignError) throw new SourceError("r2_credentials_unconfigured", error.message);
    throw error;
  }
  return { type: "url", url, max_bytes: MAX_UPLOAD_BYTES };
}
