import type { Env } from "./types";

interface GitRef { object: { sha: string } }
interface GitCommit { tree: { sha: string } }
interface GitObject { sha: string }

function githubHeaders(env: Env, accept = "application/vnd.github+json"): Headers {
  return new Headers({
    accept,
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "content-type": "application/json",
    "user-agent": "read-podcast-edge",
    "x-github-api-version": "2022-11-28",
  });
}

/** GitHub REST API 根地址；默认 api.github.com，可用 GITHUB_API_BASE 指向 GitHub Enterprise / 本地联调桩。 */
function apiBase(env: Env): string {
  return (env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
}

/** Canonical Manuscript Store 仓库的 API 路径；owner / repo 由部署注入，缺失时明确失败而不是请求 /repos//。 */
function repoPath(env: Env): string {
  const owner = (env.GITHUB_OWNER ?? "").trim();
  const repo = (env.GITHUB_REPO ?? "").trim();
  if (!owner || !repo) throw new Error("GITHUB_OWNER / GITHUB_REPO are not configured");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function github<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured");
  const response = await fetch(`${apiBase(env)}${path}`, {
    ...init,
    headers: init.headers ?? githubHeaders(env),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text();
    console.error("GitHub API request failed", response.status, body.slice(0, 500));
    const error = new Error(`GitHub API returned HTTP ${response.status}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return response.status === 204 ? (undefined as T) : response.json<T>();
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

// 兜底：仅当调用方未给出 writing_filename 时使用；不解析集号，尽量安全成名。
// 正常路径下文件名一律来自 Edge 的 build_filename_base 产物（src/refinement/naming.ts），与稿件仓库既有命名一致。
function fallbackStem(title: string, now: Date): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const cleaned = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(CONTROL_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${date}_${cleaned || "未命名单集"}`;
}

// 把不可信文件名收敛成单个安全路径分量（禁止目录穿越 / 分隔符 / 控制字符）。
// 刻意不做 NFKC 归一：原生 safe_storage_component 保留字节，全角「（）」等必须原样
// 保留，才能与稿件仓库既有文件名逐字节一致。
function safeStem(writingFilename: string): string {
  return writingFilename
    .replace(/[\\/]+/g, "_")
    .replace(CONTROL_CHARS, "_")
    .replace(/^\.+/, "")
    .replace(/\.+$/g, "")
    .trim()
    .slice(0, 200);
}

/**
 * 最终稿在 Canonical Manuscript Store 中的相对路径。
 * 目录为 GITHUB_PODCAST_PATH（默认 `podcasts/transcripts`，扁平）；
 * 文件名优先用 Edge 的 build_filename_base 产物，缺省回退安全命名。
 * 原始转录不入 GitHub（计划 §3），因此只返回 finalPath。
 */
export function podcastPaths(
  env: Env,
  writingFilename: string,
  title = "",
  now = new Date(),
): { finalPath: string } {
  const stem = safeStem(writingFilename) || fallbackStem(title, now);
  const root = env.GITHUB_PODCAST_PATH.replace(/^\/+|\/+$/g, "");
  return { finalPath: `${root}/${stem}.md` };
}

async function commitFilesOnce(
  env: Env,
  message: string,
  files: Array<{ path: string; content: string }>,
): Promise<string> {
  const base = repoPath(env);
  const branch = encodeURIComponent(env.GITHUB_BRANCH);
  const ref = await github<GitRef>(env, `${base}/git/ref/heads/${branch}`, { headers: githubHeaders(env) });
  const parent = ref.object.sha;
  const commit = await github<GitCommit>(env, `${base}/git/commits/${parent}`, { headers: githubHeaders(env) });
  const blobs = await Promise.all(files.map(file => github<GitObject>(env, `${base}/git/blobs`, {
    method: "POST",
    headers: githubHeaders(env),
    body: JSON.stringify({ content: utf8Base64(file.content), encoding: "base64" }),
  })));
  const tree = await github<GitObject>(env, `${base}/git/trees`, {
    method: "POST",
    headers: githubHeaders(env),
    body: JSON.stringify({
      base_tree: commit.tree.sha,
      tree: files.map((file, index) => ({ path: file.path, mode: "100644", type: "blob", sha: blobs[index].sha })),
    }),
  });
  const next = await github<GitObject>(env, `${base}/git/commits`, {
    method: "POST",
    headers: githubHeaders(env),
    body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }),
  });
  await github<void>(env, `${base}/git/refs/heads/${branch}`, {
    method: "PATCH",
    headers: githubHeaders(env),
    body: JSON.stringify({ sha: next.sha, force: false }),
  });
  return next.sha;
}

/**
 * 把最终 Markdown 稿提交到稿件仓库（Canonical Manuscript Store，唯一长期正文事实源）。
 * 只提交成稿，不提交原始转录（计划 §3）；非 force 更新引用，422 冲突时基于新 HEAD 重试一次。
 */
async function branchHeadSha(env: Env): Promise<string> {
  const base = repoPath(env);
  const ref = await github<GitRef>(env, `${base}/git/ref/heads/${encodeURIComponent(env.GITHUB_BRANCH)}`, { headers: githubHeaders(env) });
  return ref.object.sha;
}

async function existingContent(env: Env, path: string): Promise<string | null> {
  const response = await readPodcastContent(env, path);
  if (response.status === 404) return null;
  if (!response.ok) return null;
  return response.text();
}

export async function commitPodcast(
  env: Env,
  writingFilename: string,
  title: string,
  finalMarkdown: string,
): Promise<{ finalPath: string; commitSha: string }> {
  const paths = podcastPaths(env, writingFilename, title);

  // 幂等：目标文件已是同样内容（例如 complete 回调重放）时不重复提交，避免脏历史。
  const current = await existingContent(env, paths.finalPath);
  if (current !== null && current === finalMarkdown) {
    return { finalPath: paths.finalPath, commitSha: await branchHeadSha(env) };
  }

  const files = [{ path: paths.finalPath, content: finalMarkdown }];
  const message = `播客: ${title || writingFilename}`.slice(0, 200);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const commitSha = await commitFilesOnce(env, message, files);
      return { finalPath: paths.finalPath, commitSha };
    } catch (error) {
      lastError = error;
      if ((error as Error & { status?: number }).status !== 422 || attempt === 1) throw error;
    }
  }
  throw lastError;
}

/** 读取 Store 中的文件；`ref` 缺省为配置的分支（控制面 / 发布），公共阅读传发布时的 commit sha。 */
export async function readPodcastContent(env: Env, path: string, ref: string = env.GITHUB_BRANCH): Promise<Response> {
  const base = repoPath(env);
  const response = await fetch(
    `${apiBase(env)}${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    { headers: githubHeaders(env, "application/vnd.github.raw+json"), signal: AbortSignal.timeout(20_000) },
  );
  if (response.status === 404) return new Response(null, { status: 404 });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
  return new Response(response.body, {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "private, no-store" },
  });
}
