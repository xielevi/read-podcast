import { HttpError, json } from "./http";
import { readPodcastContent } from "./github";
import { proposeConceptCandidates } from "./refinement/concepts";
import { createRefinerClient } from "./refinement/refiner";
import { loadRefinerSettings } from "./refinement/settings";
import { verifyConceptsWikipedia, type ConceptItem } from "./wikipedia";
import type { Env } from "./types";

interface TaskConceptRow {
  id: string;
  status: string;
  podcast_name: string;
  episode_title: string;
  final_content_path: string | null;
  content_commit_sha: string | null;
}

/**
 * POST /api/control/tasks/:id/concepts
 *
 * 关键概念提取与维基百科核验管线（迁移后完全在 Cloudflare 执行）：
 * 1. 校验任务终态与稿件路径（必须 status === 'success' 且 final_content_path 存在）；
 * 2. 检查 D1 article_concepts 缓存（按 content_path + commit_sha 查询，命中则即刻返回）；
 * 3. Cache miss：从 GitHub writing 仓库读取最终 Markdown 正文；
 * 4. Edge refiner client 直接调用大模型提名候选概念（不经过任何转录服务）；
 * 5. Edge 并发调用 Wikipedia 官方 API 核验真实词条、摘要与规范 URL；
 * 6. 结果持久化至 D1 article_concepts 缓存并返回。
 *
 * 即使转录服务完全下线，已生成稿件仍然可以完成阅读、概念提取与维基百科核验。
 */
export async function taskConcepts(taskId: string, env: Env): Promise<Response> {
  const task = await env.DB.prepare(
    `SELECT id, status, podcast_name, episode_title, final_content_path, content_commit_sha
     FROM tasks WHERE id = ?`
  )
    .bind(taskId)
    .first<TaskConceptRow>();

  if (!task) {
    throw new HttpError(404, "not_found", "Task not found");
  }

  if (task.status !== "success" || !task.final_content_path) {
    throw new HttpError(409, "task_not_finished", "Task is not finished or has no final content");
  }

  // 1. D1 缓存查询（绑定 commit_sha，确保不重复消耗 Token）
  if (task.content_commit_sha) {
    const cached = await env.DB.prepare(
      "SELECT concepts_json FROM article_concepts WHERE content_path = ? AND commit_sha = ?"
    )
      .bind(task.final_content_path, task.content_commit_sha)
      .first<{ concepts_json: string }>();

    if (cached?.concepts_json) {
      try {
        const parsed = JSON.parse(cached.concepts_json) as { concepts: ConceptItem[] };
        return json(parsed);
      } catch (err) {
        console.warn("Invalid cached concepts JSON, re-extracting:", err);
      }
    }
  }

  // 2. 从 GitHub writing 仓库读取最终 Markdown 稿件
  const contentRes = await readPodcastContent(env, task.final_content_path);
  if (contentRes.status === 404) {
    throw new HttpError(404, "content_not_found", "Content not found in GitHub");
  }
  if (!contentRes.ok) {
    throw new HttpError(502, "github_error", "Failed to read content from GitHub");
  }
  const markdown = await contentRes.text();
  if (!markdown.trim()) {
    return json({ concepts: [] });
  }

  // 3. Edge refiner client 直接提名候选（转录服务无需在线）
  let candidates: string[] = [];
  try {
    const refinerSettings = await loadRefinerSettings(env);
    const client = createRefinerClient({
      apiBase: refinerSettings.apiBase,
      model: refinerSettings.model,
      apiKey: env.REFINER_API_KEY,
      temperature: 0.2,
      maxTokens: 800,
      timeoutMs: 60_000,
    });
    candidates = await proposeConceptCandidates(
      { title: task.episode_title, podcast: task.podcast_name, content: markdown, limit: 10 },
      client,
    );
  } catch (err) {
    console.error("Edge concept extraction failed:", err);
    throw new HttpError(502, "refiner_error", "Concept nomination failed");
  }

  // 4. Edge 进行维基百科事实存在性核验
  const { concepts, hasErrors } = await verifyConceptsWikipedia(candidates, { limit: 10 });
  const result = { concepts };

  // 5. 写入 D1 缓存
  // 严格防护假阴性：仅当无网络错误（或已核验出有效概念）时才缓存。
  // 若因网络波动导致全量失败，绝不写入空缓存，防止永久固化。
  if (task.content_commit_sha) {
    if (concepts.length > 0 || !hasErrors) {
      try {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO article_concepts (content_path, commit_sha, concepts_json)
           VALUES (?, ?, ?)`
        )
          .bind(task.final_content_path, task.content_commit_sha, JSON.stringify(result))
          .run();
      } catch (err) {
        console.warn("Failed to write article_concepts cache:", err);
      }
    }
  }

  // 若候选词非空但因维基百科全部网络故障导致 0 结果，抛出 502 触发前端重试机制，不展示错误的“无结果”
  if (candidates.length > 0 && concepts.length === 0 && hasErrors) {
    throw new HttpError(502, "wikipedia_unavailable", "Wikipedia verification temporarily unavailable");
  }

  return json(result);
}
