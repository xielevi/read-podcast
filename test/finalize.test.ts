/**
 * persistFinalArticle（ProcessingWorkflow publish step 的成稿持久化核心）。
 *
 * 并发与可靠性边界：
 * - status = 'finalizing' CAS：进入 external publish 前做原子 CAS，进入后状态明确为 finalizing，不可取消；
 *   同一 attempt 的 publish step retry / replay（isolate 崩溃 / 引擎重放）允许直接继续；
 *   不同 attempt（stale_attempt）或已取消（cancelled）一律拒绝；
 * - cancel vs finalization race：cancel_requested = 1 时 CAS 失败，拒绝提交；
 * - current_attempt_id CAS：旧 attempt 的提交不允许落库；
 * - GitHub commit first → D1 task success + article upsert 原子 batch；
 * - GitHub / D1 临时故障保持 status = 'finalizing'，抛 retryable error，
 *   让 publish step durable retry 直接重试（利用 GitHub 相同内容提交的幂等性，不制造重复 commit）；
 * - 不在 persistFinalArticle 内部人工释放 claim 或二次覆写 error；
 *   publish retries 最终耗尽时由外层 ProcessingWorkflow 统一收敛为 error(final_persist_failed)。
 */
import { describe, expect, it } from "vitest";
import { FinalizeError, persistFinalArticle } from "../src/finalize";
import type { Env } from "../src/types";

const TASK = "12345678-1234-1234-1234-123456789abc";
const ATTEMPT = "aaaaaaaa-0000-0000-0000-000000000001";
const FINAL_PATH = "podcasts/transcripts/20260519_测试播客_测试单集.md";
const MARKDOWN = "# 成稿\n\n正文";

interface TaskState {
  id: string;
  status: string;
  current_attempt_id: string | null;
  cancel_requested: number;
  error_code: string | null;
  final_content_path: string | null;
  content_commit_sha: string | null;
  episode_id: string | null;
  episode_title: string;
  podcast_name: string;
  progress: number;
  message: string;
}

function makeState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: TASK,
    status: "refining",
    current_attempt_id: ATTEMPT,
    cancel_requested: 0,
    error_code: null,
    final_content_path: null,
    content_commit_sha: null,
    episode_id: "ep-1",
    episode_title: "测试单集",
    podcast_name: "测试播客",
    progress: 90,
    message: "精修中",
    ...overrides,
  };
}

interface Harness {
  env: Env;
  state: TaskState;
  articles: Array<Record<string, unknown>>;
  sql: string[];
}

function harness(options: {
  state?: Partial<TaskState>;
  missingTask?: boolean;
  batchFailures?: number;
  taskUpdateChanges?: number;
} = {}): Harness {
  const state = makeState(options.state);
  const h: Harness = { state, articles: [], sql: [], env: null as unknown as Env };
  let batchFailures = options.batchFailures ?? 0;

  const db = {
    prepare(sql: string) {
      h.sql.push(sql);
      let bound: unknown[] = [];
      const statement = {
        bind: (...args: unknown[]) => {
          bound = args;
          return statement;
        },
        first: async () => {
          if (options.missingTask) return null;
          if (sql.includes("SELECT episode_id, episode_title, podcast_name")) {
            return { episode_id: state.episode_id, episode_title: state.episode_title, podcast_name: state.podcast_name };
          }
          return state;
        },
        run: async () => runStatement(sql, bound),
        all: async () => ({ results: [] }),
      };
      return statement as unknown as D1PreparedStatement;

      function runStatement(sqlText: string, args: unknown[]): { meta: { changes: number } } {
        if (sqlText.includes("SET status = 'finalizing'")) {
          const [id, attemptId] = args as [string, string];
          const ok =
            id === state.id &&
            attemptId === state.current_attempt_id &&
            state.cancel_requested === 0 &&
            (state.status === "refining" || state.status === "finalizing");
          if (!ok) return { meta: { changes: 0 } };
          state.status = "finalizing";
          state.progress = Math.max(state.progress, 95);
          state.message = "正在保存正式稿…";
          return { meta: { changes: 1 } };
        }
        if (sqlText.includes("SET status = 'success'")) {
          const [finalPath, commitSha, id, attemptId] = args as [string, string, string, string];
          const guardFails = options.taskUpdateChanges === 0 || id !== state.id || attemptId !== state.current_attempt_id || state.status !== "finalizing";
          if (guardFails) {
            return { meta: { changes: 0 } };
          }
          state.status = "success";
          state.progress = 100;
          state.message = "已完成";
          state.final_content_path = finalPath;
          state.content_commit_sha = commitSha;
          return { meta: { changes: 1 } };
        }
        if (sqlText.includes("INSERT INTO articles")) {
          h.articles.push({ task_id: args[0], content_path: args[4], commit_sha: args[5] });
          return { meta: { changes: 1 } };
        }
        if (sqlText.includes("DELETE FROM articles")) {
          h.articles.length = 0;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
    },
    batch: async (statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>) => {
      if (batchFailures > 0) {
        batchFailures -= 1;
        throw new Error("D1_BATCH_TRANSACTION_FAILED: transient");
      }
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
  };

  h.env = {
    db: db as any,
    DB: db,
    GITHUB_TOKEN: "gh-token",
    GITHUB_OWNER: "test-owner",
    GITHUB_REPO: "test-repo",
    GITHUB_BRANCH: "main",
    GITHUB_PODCAST_PATH: "podcasts/transcripts",
  } as unknown as Env;

  return h;
}

function installGithub(h: Harness, options: { failFirstCommits?: number; preCommitted?: boolean } = {}) {
  const original = globalThis.fetch;
  const state = { committed: options.preCommitted ?? false, refPatches: 0, failFirstCommits: options.failFirstCommits ?? 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("api.github.com")) return original(input);
    if (url.includes("/contents/")) {
      return state.committed ? new Response(MARKDOWN, { status: 200 }) : new Response(null, { status: 404 });
    }
    if (url.includes("/git/ref/heads/")) return new Response(JSON.stringify({ object: { sha: "head-sha" } }), { status: 200 });
    if (url.includes("/git/commits/")) return new Response(JSON.stringify({ tree: { sha: "tree-sha" } }), { status: 200 });
    if (url.includes("/git/blobs")) return new Response(JSON.stringify({ sha: "blob-sha" }), { status: 201 });
    if (url.includes("/git/trees")) return new Response(JSON.stringify({ sha: "new-tree-sha" }), { status: 201 });
    if (url.endsWith("/git/commits")) {
      if (state.failFirstCommits > 0) {
        state.failFirstCommits -= 1;
        return new Response("github down", { status: 500 });
      }
      return new Response(JSON.stringify({ sha: "commit-sha" }), { status: 200 });
    }
    if (url.includes("/git/refs/heads/")) {
      state.refPatches += 1;
      state.committed = true;
      return new Response(JSON.stringify({ sha: "commit-sha" }), { status: 200 });
    }
    return new Response(JSON.stringify({ sha: "commit-sha" }), { status: 200 });
  }) as typeof globalThis.fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    patches: () => state.refPatches,
  };
}

const persist = (h: Harness, markdown = MARKDOWN, attemptId = ATTEMPT) =>
  persistFinalArticle(h.env, { taskId: TASK, attemptId, writingFilename: "20260519_测试播客_测试单集", markdown });

async function expectFinalizeError(promise: Promise<unknown>): Promise<FinalizeError> {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof FinalizeError) return caught;
    throw caught;
  }
  throw new Error("expected the call to fail with FinalizeError");
}

describe("persistFinalArticle: 输入校验", () => {
  it("空 markdown → NonRetryable final_persist_failed", async () => {
    const h = harness();
    const error = await expectFinalizeError(persist(h, "   "));
    expect(error).toBeInstanceOf(FinalizeError);
    expect(error.code).toBe("final_persist_failed");
    expect(error.retryable).toBe(false);
  });

  it("超过 5MB → 拒绝", async () => {
    const h = harness();
    const error = await expectFinalizeError(persist(h, "x".repeat(5_000_001)));
    expect(error).toBeInstanceOf(FinalizeError);
    expect(error.message).toContain("5MB");
  });
});

describe("persistFinalArticle: finalizing CAS 与状态机", () => {
  it("任务不存在 → task_not_found", async () => {
    const h = harness({ missingTask: true });
    const error = await expectFinalizeError(persist(h));
    expect(error.code).toBe("task_not_found");
  });

  it("已 success → 幂等返回既有结果", async () => {
    const h = harness({ state: { status: "success", final_content_path: FINAL_PATH, content_commit_sha: "sha-1" } });
    const result = await persist(h);
    expect(result).toEqual({ finalPath: FINAL_PATH, commitSha: "sha-1" });
  });

  it("过期 attempt → stale_attempt（不写库）", async () => {
    const h = harness({ state: { current_attempt_id: "other-attempt" } });
    const error = await expectFinalizeError(persist(h));
    expect(error.code).toBe("stale_attempt");
    expect(h.state.status).toBe("refining");
  });

  it("cancel_requested = 1 → cancelled（cancel 赢下竞争）", async () => {
    const h = harness({ state: { cancel_requested: 1 } });
    const error = await expectFinalizeError(persist(h));
    expect(error.code).toBe("cancelled");
  });

  it("终态（error）→ not_running", async () => {
    const h = harness({ state: { status: "error" } });
    const error = await expectFinalizeError(persist(h));
    expect(error.code).toBe("not_running");
  });

  it("refining → finalizing CAS 成功，推进至 95% 并标记状态", async () => {
    const gh = installGithub(harness());
    try {
      const h = harness({ state: { status: "refining", progress: 85 } });
      const result = await persist(h);
      expect(result.finalPath).toContain("podcasts/transcripts/");
      expect(h.state.status).toBe("success");
      expect(h.state.progress).toBe(100);
      expect(h.articles).toHaveLength(1);
    } finally {
      gh.restore();
    }
  });

  it("同一 attempt 重入（publish step retry / replay）：status 已为 finalizing 时允许续跑", async () => {
    const gh = installGithub(harness());
    try {
      const h = harness({ state: { status: "finalizing", progress: 95 } });
      const result = await persist(h);
      expect(result.finalPath).toContain("podcasts/transcripts/");
      expect(h.state.status).toBe("success");
      expect(h.articles).toHaveLength(1);
    } finally {
      gh.restore();
    }
  });
});

describe("persistFinalArticle: 幂等与故障恢复", () => {
  it("GitHub 临时失败 → 保持 status = finalizing，抛 retryable error，不污染为 error 终态", async () => {
    const h = harness({ state: { status: "refining" } });
    const gh = installGithub(h, { failFirstCommits: 2 });
    try {
      const error = await expectFinalizeError(persist(h));
      expect(error).toBeInstanceOf(FinalizeError);
      expect(error.code).toBe("final_persist_failed");
      expect(error.retryable).toBe(true);
      // 保持 finalizing，让 durable retry 能够续跑
      expect(h.state.status).toBe("finalizing");
      expect(h.state.progress).toBe(95);
      expect(h.articles).toHaveLength(0);
    } finally {
      gh.restore();
    }
  });

  it("GitHub commit 成功但 D1 batch 失败 → publish step retry 识别相同内容 commit，无重复提交，最终成功", async () => {
    const h = harness({ batchFailures: 1 });
    const gh = installGithub(h);
    try {
      // 第一次：CAS 到 finalizing → GitHub commit 成功 → D1 batch 失败
      const firstError = await expectFinalizeError(persist(h));
      expect(firstError.retryable).toBe(true);
      expect(h.state.status).toBe("finalizing");
      expect(h.articles).toHaveLength(0);

      // durable retry：同 attempt 续跑 → GitHub 识别目标路径已有相同内容 → reuse（无新 commit）→ D1 success
      const result = await persist(h);
      expect(result.commitSha).toBe("head-sha");
      expect(h.state.status).toBe("success");
      expect(h.state.final_content_path).toBe(FINAL_PATH);
      expect(h.articles).toHaveLength(1);
      expect(gh.patches()).toBe(1); // 整个过程只有 1 次真实 PATCH
    } finally {
      gh.restore();
    }
  });

  it("GitHub commit 后 isolate 崩溃 → 同 attempt 重放直接完成 D1 success", async () => {
    const h = harness({ state: { status: "finalizing" } });
    const gh = installGithub(h, { preCommitted: true });
    try {
      const result = await persist(h);
      expect(result.commitSha).toBe("head-sha");
      expect(h.state.status).toBe("success");
      expect(h.articles).toHaveLength(1);
      expect(gh.patches()).toBe(0); // 未发生新 commit
    } finally {
      gh.restore();
    }
  });

  it("finalization 期间 attempt 被轮换 → 丢弃提交（stale_attempt）并清理 article", async () => {
    const h = harness({ taskUpdateChanges: 0 });
    const gh = installGithub(h);
    try {
      const error = await expectFinalizeError(persist(h));
      expect(error.code).toBe("stale_attempt");
      expect(h.state.status).not.toBe("success");
      expect(h.sql.some(statement => statement.includes("DELETE FROM articles"))).toBe(true);
    } finally {
      gh.restore();
    }
  });

  it("顺序不变式：GitHub commit 发生在 D1 success 更新之前", async () => {
    const h = harness();
    const gh = installGithub(h);
    try {
      await persist(h);
      const successIndex = h.sql.findIndex(statement => statement.includes("SET status = 'success'"));
      expect(successIndex).toBeGreaterThanOrEqual(0);
      expect(h.state.status).toBe("success");
      expect(h.state.final_content_path).toContain("podcasts/transcripts/");
      expect(h.state.content_commit_sha).toBe("commit-sha");
    } finally {
      gh.restore();
    }
  });
});
