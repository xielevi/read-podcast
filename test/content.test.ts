/**
 * 正文读取 / 下载端点测试（GET /tasks/:id/content、GET /tasks/:id/download）。
 *
 * 正文不在 D1：D1 只给 content_path，正文由当前 Output Backend（GitHub）提供。
 * 因此这里断言的是「D1 索引 → Output Backend 取正文」这条边界，而不是正文存储本身。
 * Output Backend 被替换时，这组用例应当随实现一起改。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskContent, taskDownload } from "../src/tasks";
import type { Env } from "../src/types";

const TASK = "12345678-1234-1234-1234-123456789abc";
const CONTENT_PATH = "podcasts/transcripts/20260519_忽左忽右_475.md";
const MARKDOWN = "# 标题\n\n正文内容";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockEnv(row: Record<string, unknown> | null) {
  const calls = { sql: [] as string[] };
  const statement = {
    bind: () => statement,
    first: async () => row,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 0 } }),
  };
  return {
    env: {
      DB: {
        prepare: (sql: string) => {
          calls.sql.push(sql);
          return statement;
        },
      },
      GITHUB_TOKEN: "gh-token",
      GITHUB_OWNER: "your-github-username",
      GITHUB_REPO: "your-manuscript-repository",
      GITHUB_BRANCH: "main",
    } as unknown as Env,
    calls,
  };
}

/** 记录请求并把 GitHub contents 端点固定成给定响应。 */
function mockOutputBackend(handler: (url: string, init?: RequestInit) => Response) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    return handler(url, init);
  }) as typeof globalThis.fetch;
  return requests;
}

const markdownOk = () => new Response(MARKDOWN, { status: 200, headers: { "content-type": "text/plain" } });

describe("taskContent（GET /tasks/:id/content）", () => {
  it("非 success 或没有 content_path → 404 content_not_found，且不请求 Output Backend", async () => {
    for (const row of [null, { final_content_path: null }]) {
      const { env, calls } = mockEnv(row);
      const requests = mockOutputBackend(markdownOk);
      const res = await taskContent(TASK, env);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "content_not_found" } });
      expect(requests).toHaveLength(0);
      // 只看 success 任务
      expect(calls.sql[0]).toContain("status = 'success'");
    }
  });

  it("命中：从当前 Output Backend 取回正文", async () => {
    const { env } = mockEnv({ final_content_path: CONTENT_PATH });
    const requests = mockOutputBackend(markdownOk);

    const res = await taskContent(TASK, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(MARKDOWN);

    expect(requests).toHaveLength(1);
    const url = new URL(requests[0].url);
    expect(url.origin).toBe("https://api.github.com");
    expect(url.pathname).toBe(
      `/repos/your-github-username/your-manuscript-repository/contents/${CONTENT_PATH.split("/").map(encodeURIComponent).join("/")}`,
    );
    expect(url.searchParams.get("ref")).toBe("main");
    // 明确用 raw 媒体类型取正文，避免拿到 base64 信封
    const accept = new Headers(requests[0].init?.headers).get("accept");
    expect(accept).toBe("application/vnd.github.raw+json");
  });

  it("Output Backend 返回 404（稿件已不在）→ 同样映射为 404 content_not_found", async () => {
    const { env } = mockEnv({ final_content_path: CONTENT_PATH });
    mockOutputBackend(() => new Response(null, { status: 404 }));

    const res = await taskContent(TASK, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "content_not_found" } });
  });

  it("Output Backend 其它错误（如 500）向上抛出，不伪装成 404", async () => {
    const { env } = mockEnv({ final_content_path: CONTENT_PATH });
    mockOutputBackend(() => new Response("boom", { status: 500 }));
    await expect(taskContent(TASK, env)).rejects.toThrow("GitHub API returned HTTP 500");
  });
});

describe("taskDownload（GET /tasks/:id/download）", () => {
  it("没有 content_path → 404 content_not_found", async () => {
    const { env } = mockEnv(null);
    mockOutputBackend(markdownOk);
    expect((await taskDownload(TASK, env)).status).toBe(404);
  });

  it("命中：attachment + UTF-8 文件名 + 禁止缓存", async () => {
    const { env } = mockEnv({ episode_title: "475 孙立天谈康熙废储", final_content_path: CONTENT_PATH });
    mockOutputBackend(markdownOk);

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
    mockOutputBackend(markdownOk);

    const res = await taskDownload(TASK, env);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("podcast.md")}`,
    );
  });

  it("Output Backend 404 → 404 content_not_found", async () => {
    const { env } = mockEnv({ episode_title: "x", final_content_path: CONTENT_PATH });
    mockOutputBackend(() => new Response(null, { status: 404 }));
    expect((await taskDownload(TASK, env)).status).toBe(404);
  });
});
