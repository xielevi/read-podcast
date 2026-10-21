import { error, json, parseLimit, parseOffset } from "./http";
import { detectLanguageFromText, normalizeContentLanguage } from "./language";
import { generateBrief, parseStoredBrief, type ArticleBrief } from "./refinement/brief";
import { stripLeadingFrontmatter } from "./refinement/formatter";
import { RefinerError } from "./refinement/refiner";
import { loadRefinerSettings } from "./refinement/settings";
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

/**
 * POST /articles/:task_id/brief —— 为已发布稿件补生成导读（旧稿件回填，主人手动触发）。
 * 读取发布快照（content_path@commit_sha），优先复用 frontmatter 里已有的 brief，否则用当前精修设置
 * 调一次 Refinement Provider；只写 articles.brief，且以 commit_sha 为条件，绝不覆盖更新的版本，
 * 也不重新发布 Markdown，也不改 updated_at（稿件库按它排序）。已有导读时直接返回，不再计费。
 */
export async function backfillArticleBrief(taskId: string, env: Env): Promise<Response> {
  const article = await env.db.prepare(
    `SELECT articles.content_path, articles.commit_sha, articles.brief, tasks.content_language
     FROM articles LEFT JOIN tasks ON tasks.id = articles.task_id WHERE articles.task_id = ?`,
  ).bind(taskId).first<{ content_path: string; commit_sha: string; brief: string | null; content_language: string | null }>();
  if (!article) return error(404, "article_not_found", "Article not found");

  const existing = parseStoredBrief(article.brief);
  if (existing) return json({ brief: existing, generated: false });

  const markdown = await env.manuscripts.read(article.content_path, article.commit_sha);
  if (markdown == null) return error(404, "manuscript_not_found", "Published manuscript not found in the store");

  let brief = frontmatterBrief(markdown);
  const generated = !brief;
  if (!brief) {
    const body = stripLeadingFrontmatter(markdown);
    const lang = normalizeContentLanguage(article.content_language) ?? detectLanguageFromText(body);
    try {
      const settings = await loadRefinerSettings(env);
      brief = await generateBrief({ markdown: body, lang, config: settings, apiKey: env.REFINER_API_KEY });
    } catch (caught) {
      if (caught instanceof RefinerError) return error(502, caught.code, caught.message);
      throw caught;
    }
  }
  if (!brief) return error(422, "brief_unavailable", "The model did not return a usable brief; try again later");

  await env.db.prepare("UPDATE articles SET brief = ? WHERE task_id = ? AND commit_sha = ?")
    .bind(JSON.stringify(brief), taskId, article.commit_sha).run();
  return json({ brief, generated });
}

/** 发布时写进 frontmatter 的单行 JSON `brief:`（见 src/refinement/formatter.ts）。 */
function frontmatterBrief(markdown: string): ArticleBrief | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = match?.[1].split(/\r?\n/).find(entry => entry.startsWith("brief:"));
  return line ? parseStoredBrief(line.slice("brief:".length).trim()) : null;
}
