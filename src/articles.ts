import { error, json, parseLimit, parseOffset } from "./http";
import { parseStoredBrief, type ArticleBrief } from "./refinement/brief";
import type { Env } from "./types";

export interface ArticleRow {
  task_id: string;
  episode_id: string | null;
  title: string;
  podcast_name: string;
  content_path: string;
  commit_sha: string;
  created_at: string;
  updated_at: string;
}

/** GET /articles —— 稿件库列表（以 articles 表为事实来源，与任务执行历史解耦）。 */
export async function listArticles(url: URL, env: Env): Promise<Response> {
  const limit = parseLimit(url, 50, 200);
  const offset = parseOffset(url);

  const result = await env.db.prepare(
    `SELECT task_id, episode_id, title, podcast_name, content_path, commit_sha, created_at, updated_at
     FROM articles
     ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<ArticleRow>();

  return json(result.results);
}

/**
 * GET /articles/:task_id —— 根据 task_id 查询特定正式稿索引元数据（含导读）。
 * brief 是显式白名单字段：D1 中的 JSON 解析为对象，缺失 / 损坏 → null（旧稿件）。
 * 列表接口不带 brief：每篇数 KB，稿件库一次取 200 篇时没必要整体下发。
 */
export async function getArticle(taskId: string, env: Env): Promise<Response> {
  const article = await env.db.prepare(
    `SELECT task_id, episode_id, title, podcast_name, content_path, commit_sha, created_at, updated_at, brief
     FROM articles WHERE task_id = ?`,
  ).bind(taskId).first<ArticleRow & { brief: string | null }>();

  if (!article) return error(404, "article_not_found", "Article not found");
  const { brief, ...row } = article;
  const dto: ArticleRow & { brief: ArticleBrief | null } = { ...row, brief: parseStoredBrief(brief) };
  return json(dto);
}
