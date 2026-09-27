/**
 * Transcription Service 协议（Cloudflare-facing contract）。
 *
 * 一个与部署无关的中性契约：任何实现（本机 MLX、Windows + CUDA Whisper、Linux / NAS、云 GPU）
 * 只要满足这组 HTTP + JSON 接口，Cloudflare 就能无差别调用——不依赖共享文件系统、本机路径、
 * launchd 或任何具体引擎。
 *
 * 为什么是异步任务模型而不是一个长连接 `POST /transcribe`（平台事实，见 PR 说明）：
 *   - 经反向代理 / Tunnel 的出站 HTTP 有默认 125s 的读超时（524，仅 Enterprise 可调，上限 6000s）；
 *   - 真实播客转录可达数小时；
 *   - Workflow 的 step 虽然墙钟不受限，但 replay 时无法接管一条已断开的长连接。
 * 因此：提交 → 202 + provider_request_id；之后由 Workflow 的 durable step 长轮询取结果。
 *
 *   POST   /v1/transcriptions                       提交（以 request_id 幂等）
 *   GET    /v1/transcriptions/{provider_request_id}  状态 / 进度 / 结果元数据（?wait=N 长轮询）
 *   GET    /v1/transcriptions/{provider_request_id}/result  原始转录正文（text/plain）
 *   DELETE /v1/transcriptions/{provider_request_id}  尽力取消并释放资源
 *   GET    /health                                   唯一的健康端点（本机 curl / 经 Access 探测）
 *
 * 认证不在协议里：reference production path 由 Cloudflare Access 在 Tunnel 入口承担，
 * 服务自身不验任何 application token。
 *
 * `request_id` = `<task>:<attempt>`，是 Cloudflare 给的幂等键；`provider_request_id` 只是「一次外部
 * 计算请求」的不透明句柄。业务 task / attempt 仍完全属于 Cloudflare。
 *
 * **正文与状态分开**：raw transcript 最大 8 MiB，而轮询要跑上百次。把正文放进状态快照意味着
 * Cloudflare 会在「轮询看到 completed」和「取回正文落 R2」时各下载并解析一遍完整正文——
 * 纯粹的重复传输与重复 CPU。所以状态端点只回小元数据，正文单独取一次。
 */

export const TRANSCRIPTIONS_PATH = "/v1/transcriptions";
/** 原始转录正文的独立端点（相对 provider_request_id）。 */
export const TRANSCRIPTION_RESULT_SUFFIX = "/result";
export const HEALTH_PATH = "/health";

export interface TranscriptionSource {
  type: "url";
  url: string;
  /** 调用方给定的体积上限（自定义上传的 200 MiB 硬上限）；服务与自身上限取较小者。 */
  max_bytes?: number;
}

export interface TranscriptionOptions {
  /** 真正影响一次转录的参数（引擎默认自动判定语言）；其余属于服务本机的内建默认值。 */
  language?: string;
}

export interface TranscriptionRequestBody {
  request_id: string;
  source: TranscriptionSource;
  options?: TranscriptionOptions;
}

export type ProviderStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ProviderPhase = "queued" | "fetching" | "preparing" | "transcribing";

/**
 * 完成状态里的**元数据**——刻意不含正文（正文只在 `persist-raw-N` 从 /result 取一次）。
 * 这些字段只用来描述一次转录的事实，不参与 Cloudflare 的任何业务判断。
 */
export interface TranscriptionResultMeta {
  language: string;
  duration: number;
}

export interface TranscriptionSnapshot {
  request_id: string;
  provider_request_id: string;
  status: ProviderStatus;
  progress?: { phase: ProviderPhase; percent: number; message?: string };
  result?: TranscriptionResultMeta;
  error?: { code: string; message?: string };
}

/** request_id 只由 Cloudflare 生成：同一 (task, attempt) 永远得到同一个键。 */
export function transcriptionRequestId(taskId: string, attemptId: string): string {
  return `${taskId}:${attemptId}`;
}

/**
 * 服务在 failed 快照里给出的 error.code —— 服务只报告事实，「是否重试」由 Cloudflare 判断。
 * 下表是 Cloudflare 的判断：这些原因重试不会改变结论，直接终止；其余一律视为可重试（受提交次数上限约束）。
 */
export const NON_RETRYABLE_PROVIDER_ERRORS: ReadonlySet<string> = new Set([
  "source_not_allowed", // URL 不合规 / 指向私网
  "source_too_large", // 超过体积上限
  "engine_rejected_audio", // 引擎明确拒收该音频
  "transcription_empty", // 引擎返回空文本
  "unsupported_source",
  "invalid_request",
]);

/** provider 错误码 → 任务错误码（用户可见的稳定归因）。 */
export function taskErrorCodeForProvider(code: string): string {
  switch (code) {
    case "source_not_allowed":
      return "source_not_allowed";
    case "source_too_large":
      return "source_too_large";
    case "source_fetch_failed":
      return "audio_download_failed";
    case "transcription_empty":
      return "transcription_invalid";
    case "unsupported_source":
    case "invalid_request":
      return "transcription_request_rejected";
    default:
      return "transcription_failed";
  }
}

export type ServiceErrorKind =
  | "unconfigured" // Cloudflare 侧没配 endpoint / Access 凭据
  | "unreachable" // 连不上 / DNS / 连接被拒
  | "timeout" // 连接或响应超时
  | "http" // 服务返回了错误状态码
  | "protocol"; // 响应不满足契约（缺字段 / request_id 不匹配 …）

/** 与转录服务通信时的错误：`retryable` 由 Cloudflare 的分类表决定，而不是服务自己说了算。 */
export class TranscriptionServiceError extends Error {
  constructor(
    readonly kind: ServiceErrorKind,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TranscriptionServiceError";
  }
}
