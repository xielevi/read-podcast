import type { Database, ManuscriptStore, ObjectStore, TaskWorkflowEngine } from "./platform/types";

export interface Env {
  db: Database;
  storage: ObjectStore;
  // Canonical Manuscript Store:成稿唯一长期事实源。CF = GitHub 仓库;Docker = 本地目录
  // (默认)或 GitHub 回落。由平台装配层注入,业务层只经此读写,选择不在运行时发生。
  manuscripts: ManuscriptStore;
  workflows?: TaskWorkflowEngine;
  assets?: { fetch: (request: Request) => Promise<Response> };
  APP_ENV: string;
  // 转录服务：Cloudflare 唯一需要知道的外部计算能力（endpoint + Access 凭据）。
  // 换转录机器 = 部署新的 Transcription Service（通过 Tunnel 暴露），改这几项，停掉旧机器。
  TRANSCRIPTION_SERVICE_URL: string;
  // 转录实现选择：self-hosted（默认，自托管 Transcription Service）| dashscope（百炼 Paraformer，
  // Worker 内适配器，见 src/transcription/dashscope.ts）。部署时由 scripts/deploy.mjs 注入。
  TRANSCRIPTION_PROVIDER?: string;
  // TRANSCRIPTION_PROVIDER=dashscope 时的百炼 API Key（Wrangler secret；音频 URL 会发给阿里云）。
  DASHSCOPE_API_KEY?: string;
  // 随请求下发的转录选项（引擎不支持时忽略）。model 不在这里：本机 MLX 模型由服务端内建默认决定。
  TRANSCRIPTION_LANGUAGE?: string;
  // 自定义上传音频的受控访问：针对确切 object key 签发临时 presigned GET URL，
  // 转录服务只拿到 URL，不持有任何存储凭据，音频也不经应用中转。
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
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
  // 控制面访问认证（Basic Auth）：保护 /manage* 与 /api/control/*，workers.dev 部署时必需。
  CONTROL_AUTH_USER?: string;
  CONTROL_AUTH_PASSWORD?: string;
  CONTROL_AUTH_MODE?: "access" | "local";
  // 本地 / 容器内网部署：受信任的内网转录端点（如 Docker compose 网络），允许在无 Cloudflare Access 凭据时调用
  TRUSTED_INTERNAL_TRANSCRIPTION?: string | boolean;
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
 * - finalizing   : AI 精修与质量门禁通过，正在向 Canonical Manuscript Store 提交正式稿（不可取消边界）；
 * - success      : Store 写入成功且 D1 task / article 索引已同步更新。
 */
export type TaskStatus = "queued" | "transcribing" | "refining" | "finalizing" | "success" | "error" | "cancelled";

export type TranscriptionPhase = "fetching" | "preparing" | "transcribing";
