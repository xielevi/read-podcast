import { HttpError, error, json } from "./http";
import { createSubscription, deleteSubscription } from "./subscriptions";
import {
  artwork,
  getEpisodeSummary,
  getReadState,
  listSubscriptions,
  putReadState,
  searchPodcast,
} from "./episodes";
import {
  cancelOrDeleteTask,
  createCustomTask,
  createTask,
  getTask,
  listTasks,
  retryTask,
  runMaintenance,
  taskContent,
  taskDownload,
} from "./tasks";
import { getArticle, listArticles } from "./articles";
import { listEpisodePage } from "./episode_page";
import {
  publicArticleConcepts,
  publicArticleContent,
  publicArticleDownload,
  publicArtwork,
  publicListArticles,
  publicListSubscriptions,
  publicSearchPodcast,
} from "./public";
import { taskConcepts } from "./concepts";
import { getSettings, putSettings, testSettings } from "./settings";
import { listPromptTemplates } from "./templates";
import { getPublicPreferences, getControlPreferences, putControlPreferences } from "./preferences";
import {
  handleAbortMultipartUpload,
  handleCompleteMultipartUpload,
  handleStartMultipartUpload,
  handleUploadAudio,
  handleUploadPart,
} from "./uploads";
import type { Env } from "./types";

// 两个 API 命名空间，按路径划定安全边界（Cloudflare Access 按路径生效）：
//   /api/public/*  Public Browse Mode —— 匿名可访问，严格只读、无副作用（见 src/public.ts）；
//   /api/control/* Authenticated Control Mode —— 由 Cloudflare Access 在请求到达应用前保护。
// 按副作用而不是 HTTP 方法划分：会刷新 RSS 的单集读取、概念抽取等都只在控制面。
// 应用内不做任何身份认证；除这两个前缀外不存在其他 API（旧的 /api/read-podcast/* 已删除，
// 不能留作绕过 Access 的别名）。
const PUBLIC_API = "/api/public";
const API = "/api/control";

async function routePublic(path: string, url: URL, env: Env): Promise<Response> {
  if (path === `${PUBLIC_API}/health`) {
    return json({ status: "ok", service: "read-podcast-edge", environment: env.APP_ENV });
  }
  if (path === `${PUBLIC_API}/subscriptions`) return publicListSubscriptions(env);
  if (path === `${PUBLIC_API}/episodes/page`) return listEpisodePage(url, env, "public");
  if (path === `${PUBLIC_API}/episodes/summary`) return getEpisodeSummary(url, env);
  if (path === `${PUBLIC_API}/search/podcast`) return publicSearchPodcast(url);
  if (path === `${PUBLIC_API}/artwork`) return publicArtwork(url, env);
  if (path === `${PUBLIC_API}/articles`) return publicListArticles(url, env);
  if (path === `${PUBLIC_API}/preferences`) return getPublicPreferences(env);
  const match = path.match(/^\/api\/public\/articles\/([0-9a-f-]+)\/(content|download|concepts)$/i);
  if (match?.[2] === "content") return publicArticleContent(match[1], url, env);
  if (match?.[2] === "download") return publicArticleDownload(match[1], url, env);
  if (match?.[2] === "concepts") return publicArticleConcepts(match[1], env);
  return error(404, "not_found", "API route not found");
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path.startsWith(`${PUBLIC_API}/`)) {
    // 公共面只接受安全方法：写方法一律 405，不会进入任何处理函数。
    if (method !== "GET" && method !== "HEAD") return error(405, "method_not_allowed", "Public API is read-only");
    return routePublic(path, url, env);
  }
  if (!path.startsWith(`${API}/`)) {
    if (path.startsWith("/api/")) return error(404, "not_found", "API route not found");
    return env.ASSETS.fetch(request);
  }

  // ── 配置（Settings）、偏好（Preferences）与 Prompt 模板 ──
  if (path === `${API}/settings` && method === "GET") return getSettings(env);
  if (path === `${API}/settings` && method === "PUT") return putSettings(request, env);
  if (path === `${API}/settings/test` && method === "POST") return testSettings(request, env);
  if (path === `${API}/preferences` && method === "GET") return getControlPreferences(env);
  if (path === `${API}/preferences` && method === "PUT") return putControlPreferences(request, env);
  if (path === `${API}/prompt-templates` && method === "GET") return listPromptTemplates();

  // ── 音频上传（单流与分片 Multipart）──
  if (path === `${API}/uploads/multipart/start` && method === "POST") return handleStartMultipartUpload(request, url, env);
  const uploadPartMatch = path.match(/^\/api\/control\/uploads\/multipart\/([0-9a-f-]+)\/parts\/(\d+)$/i);
  if (uploadPartMatch && method === "PUT") return handleUploadPart(request, uploadPartMatch[1], uploadPartMatch[2], env);
  const uploadCompleteMatch = path.match(/^\/api\/control\/uploads\/multipart\/([0-9a-f-]+)\/complete$/i);
  if (uploadCompleteMatch && method === "POST") return handleCompleteMultipartUpload(request, uploadCompleteMatch[1], env);
  const uploadAbortMatch = path.match(/^\/api\/control\/uploads\/multipart\/([0-9a-f-]+)\/abort$/i);
  if (uploadAbortMatch && method === "POST") return handleAbortMultipartUpload(request, uploadAbortMatch[1], env);
  if (path === `${API}/uploads` && method === "POST") return handleUploadAudio(request, url, env);

  // ── 订阅 / RSS / 剧集 / 已读 ──
  if (path === `${API}/subscriptions` && method === "GET") return listSubscriptions(env);
  if (path === `${API}/subscriptions` && method === "POST") return createSubscription(request, env);
  const subscriptionMatch = path.match(/^\/api\/control\/subscriptions\/(.+)$/);
  if (subscriptionMatch && method === "DELETE") return deleteSubscription(subscriptionMatch[1], env);

  if (path === `${API}/episodes/page` && method === "GET") return listEpisodePage(url, env, "control", ctx);
  if (path === `${API}/episodes/summary` && method === "GET") return getEpisodeSummary(url, env);
  if (path === `${API}/episodes/read` && method === "GET") return getReadState(url, env);
  if (path === `${API}/episodes/read` && method === "PUT") return putReadState(request, env);
  if (path === `${API}/search/podcast` && method === "GET") return searchPodcast(url, env);
  if (path === `${API}/artwork` && method === "GET") return artwork(url, env);

  // ── 稿件库（以 articles 为事实来源）──
  if (path === `${API}/articles` && method === "GET") return listArticles(url, env);
  const articleMatch = path.match(/^\/api\/control\/articles\/([0-9a-f-]+)$/i);
  if (articleMatch && method === "GET") return getArticle(articleMatch[1], env);

  // ── 任务 ──（更具体的路径必须先于 /tasks/:id 匹配）
  if (path === `${API}/tasks/custom` && method === "POST") return createCustomTask(request, env, ctx);
  if (path === `${API}/tasks` && method === "POST") return createTask(request, env, ctx);
  if (path === `${API}/tasks` && method === "GET") return listTasks(url, env);
  const retryMatch = path.match(/^\/api\/control\/tasks\/([0-9a-f-]+)\/retry$/i);
  if (retryMatch && method === "POST") return retryTask(retryMatch[1], env, ctx);
  const contentMatch = path.match(/^\/api\/control\/tasks\/([0-9a-f-]+)\/content$/i);
  if (contentMatch && method === "GET") return taskContent(contentMatch[1], env);
  const downloadMatch = path.match(/^\/api\/control\/tasks\/([0-9a-f-]+)\/download$/i);
  if (downloadMatch && method === "GET") return taskDownload(downloadMatch[1], env);
  const conceptsMatch = path.match(/^\/api\/control\/tasks\/([0-9a-f-]+)\/concepts$/i);
  if (conceptsMatch && method === "POST") return taskConcepts(conceptsMatch[1], env);
  const taskMatch = path.match(/^\/api\/control\/tasks\/([0-9a-f-]+)$/i);
  if (taskMatch && method === "GET") return getTask(taskMatch[1], env);
  if (taskMatch && method === "DELETE") return cancelOrDeleteTask(taskMatch[1], env, ctx);

  return error(404, "not_found", "API route not found");
}

export default {
  // Cloudflare 自有的收敛动作（未启动的 queued 任务 / Workflow 存活对账），
  // 不依赖任何外部节点。
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMaintenance(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (caught) {
      if (caught instanceof HttpError) return error(caught.status, caught.code, caught.message);
      console.error("Unhandled request error", caught);
      return error(500, "internal_error", "Unexpected server error");
    }
  },
} satisfies ExportedHandler<Env>;

// Cloudflare Workflows 入口：任务从创建到成稿（转录 → raw 落库 → 精修 → 质量门禁 → Formatter → GitHub）的唯一执行体。
export { ProcessingWorkflow } from "./workflows/processing";
