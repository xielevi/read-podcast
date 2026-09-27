/**
 * 正文读取 / 下载端点测试（GET /tasks/:id/content、GET /tasks/:id/download）。
 *
 * 正文不在 D1：D1 只给 content_path，正文由 Canonical Manuscript Store（env.manuscripts）提供。
 * 因此这里断言的是「D1 索引 → Store 取正文」这条边界，而不是正文存储本身。
 * Store 的具体实现（GitHub / 本地目录）被替换时，这组用例不随实现改变。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskContent, taskDownload } from "../src/tasks";
import type { Env } from "../src/types";

const TASK = "12345678-1234-1234-1234-123456789abc";
const CONTENT_PATH = "podcasts/transcripts/20260519_忽左忽右_475.md";
const MARKDOWN = "# 标题\n\n正文内容";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockEnv(row: Record<string, unknown> | null, readImpl?: () => Promise<string | null>) {
  const calls = { sql: [] as string[] };
  const statement = {
    bind: () => statement,
    first: async () => row,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 0 } }),
  };
  const db = {
    prepare: (sql: string) => {
      calls.sql.push(sql);
      return statement;
    },
  };
  const read = vi.fn(readImpl ?? (async () => MARKDOWN));
  return {
    env: {
      db,
      DB: db,
      manuscripts: { publish: vi.fn(), read, list: vi.fn(async () => []) },
      GITHUB_TOKEN: "gh-token",
      GITHUB_OWNER: "your-github-username",
      GITHUB_REPO: "your-manuscript-repository",
      GITHUB_BRANCH: "main",
    } as unknown as Env,
    calls,
    read,
  };
}

describe("taskContent（GET /tasks/:id/content）", () => {
  it("非 success 或没有 content_path → 404 content_not_found，且不访问 Store", async () => {
    for (const row of [null, { final_content_path: null }]) {
      const { env, calls, read } = mockEnv(row);
      const res = await taskContent(TASK, env);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "content_not_found" } });
      expect(read).not.toHaveBeenCalled();
      // 只看 success 任务
      expect(calls.sql[0]).toContain("status = 'success'");
    }
  });

  it("命中：从当前 Store 取回正文", async () => {
    const { env, read } = mockEnv({ final_content_path: CONTENT_PATH });

    const res = await taskContent(TASK, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(MARKDOWN);

    // 缺省读当前版本（控制面语义），路径来自 D1 索引
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(CONTENT_PATH);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("Store 返回 null（稿件已不在）→ 同样映射为 404 content_not_found", async () => {
    const { env } = mockEnv({ final_content_path: CONTENT_PATH }, async () => null);

    const res = await taskContent(TASK, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "content_not_found" } });
  });

  it("Store 其它错误（如 500）向上抛出，不伪装成 404", async () => {
    const { env } = mockEnv({ final_content_path: CONTENT_PATH }, async () => {
      throw new Error("Store read failed: HTTP 500");
    });
    await expect(taskContent(TASK, env)).rejects.toThrow("Store read failed: HTTP 500");
  });
});

describe("taskDownload（GET /tasks/:id/download）", () => {
  it("没有 content_path → 404 content_not_found", async () => {
    const { env } = mockEnv(null);
    expect((await taskDownload(TASK, env)).status).toBe(404);
  });

  it("命中：attachment + UTF-8 文件名 + 禁止缓存", async () => {
    const { env } = mockEnv({ episode_title: "475 孙立天谈康熙废储", final_content_path: CONTENT_PATH });

    const res = await taskDownload(TASK, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(MARKDOWN);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("475 孙立天谈康熙废储.md")}`,
    );
  });

  it("标题为空时回退为 podcast.md", async () => {
    const { env } = mockEnv({ episode_title: "", final_content_path: CONTENT_PATH });

    const res = await taskDownload(TASK, env);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("podcast.md")}`,
    );
  });

  it("Store 返回 null → 404 content_not_found", async () => {
    const { env } = mockEnv({ episode_title: "x", final_content_path: CONTENT_PATH }, async () => null);
    expect((await taskDownload(TASK, env)).status).toBe(404);
  });
});
