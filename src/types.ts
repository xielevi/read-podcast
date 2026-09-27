import type { ProcessingWorkflowParams } from "./workflows/common";

export interface Env {
  DB: D1Database;
  RAW_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  PROCESSING_WORKFLOW: Workflow<ProcessingWorkflowParams>;
  APP_ENV: string;
  // 转录服务：Cloudflare 唯一需要知道的外部计算能力（endpoint + Access 凭据）。
  // 换转录机器 = 部署新的 Transcription Service（通过 Tunnel 暴露），改这几项，停掉旧机器。
  TRANSCRIPTION_SERVICE_URL: string;
  // 随请求下发的转录选项（引擎不支持时忽略）。model 不在这里：本机 MLX 模型由服务端内建默认决定。
  TRANSCRIPTION_LANGUAGE?: string;
  // 自定义上传音频的受控访问：Cloudflare 针对确切 object key 签发**临时 presigned GET URL**，
  // 转录服务只拿到 URL，不持有任何 R2 / Cloudflare 凭据，音频也不经 Worker 中转。
  //
  // 这四项都不进仓库（见 wrangler.jsonc 注释与 .dev.vars.example）：
  //   npx wrangler secret put R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
  // R2_BUCKET_NAME 是 var（值与 r2_buckets[].bucket_name 相同，不是机密）。
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  REFINER_API_KEY: string;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GITHUB_PODCAST_PATH: string;
  // 可选：稿件 frontmatter processed_at 的 IANA 时区；缺省 Asia/Shanghai（见 src/refinement/formatter.ts）。
  MANUSCRIPT_TIME_ZONE?: string;
  // 可选：GitHub API 根地址（GitHub Enterprise / 本地联调）；缺省 https://api.github.com。
  GITHUB_API_BASE?: string;
  // 转录服务前面由 Cloudflare Access 保护（Tunnel 入口的 service token）。
  // 生产路径必填；endpoint 指向本机（本地开发）时可以不配置。
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}

/**
 * 任务生命周期（全部由 Cloudflare 拥有）：
 *
 *   queued ──▶ transcribing ──▶ refining ──▶ finalizing ──▶ success
 *      │            │              │             │
 *      └────────────┴──────────────┴─────────────┴──▶ error
 *      │            │              │
 *      └────────────┴──────────────┴──▶ cancelled
 *
 * - queued       : 任务已创建，Processing Workflow 即将 / 刚刚启动；
 * - transcribing : Workflow 已向转录服务提交请求（取音频 / 准备 / 转录是其子阶段，见 transcription_phase）；
 * - refining     : raw 已持久化到 R2，Workflow 正在精修 / 质量门禁；
 * - finalizing   : AI 精修与质量门禁通过，正在向 canonical Output Backend 提交正式稿（不可取消边界）；
 * - success      : Output Backend 写入成功且 D1 task / article 索引已同步更新。
 */
export type TaskStatus = "queued" | "transcribing" | "refining" | "finalizing" | "success" | "error" | "cancelled";

export type TranscriptionPhase = "fetching" | "preparing" | "transcribing";
