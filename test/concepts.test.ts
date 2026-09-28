import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskConcepts } from "../src/concepts";
import {
  fetchWikipediaSummary,
  lookupConcept,
  searchWikipedia,
  titlesRelated,
  verifyConceptsWikipedia,
} from "../src/wikipedia";
import worker from "../src/index";
import type { Env } from "../src/types";

const TASK_ID = "12345678-1234-1234-1234-123456789abc";
const COMMIT_SHA = "c0ffee1234567890abcdef1234567890abcdef12";
const FINAL_PATH = "podcasts/transcripts/20260519_测试单集.md";

describe("titlesRelated", () => {
  it("accepts exact title matches", () => {
    expect(titlesRelated("OpenAI", "OpenAI")).toBe(true);
    expect(titlesRelated("量子计算", "量子计算")).toBe(true);
  });

  it("accepts prefix / length expansion with sufficient similarity", () => {
    expect(titlesRelated("量子计算", "量子计算机")).toBe(true); // 4/5 = 0.8 >= 0.6
    expect(titlesRelated("斯坦福大学", "斯坦福大学（美国）")).toBe(true); // 消歧义括号忽略
  });

  it("accepts transliterated foreign surname matching suffix", () => {
    expect(titlesRelated("韦伯", "马克斯·韦伯")).toBe(true);
    expect(titlesRelated("斯密", "亚当·斯密")).toBe(true);
    expect(titlesRelated("凯恩斯", "约翰·梅纳德·凯恩斯")).toBe(true);
  });

  it("rejects search noise, unrelated titles, and overly short substrings", () => {
    expect(titlesRelated("阿尔法折叠", "CASP")).toBe(false);
    expect(titlesRelated("AI", "AIDS")).toBe(false);
    expect(titlesRelated("强化学习", "机器学习")).toBe(false);
    expect(titlesRelated("微积分", "微积分学")).toBe(true); // 3/4 = 0.75 >= 0.6
    expect(titlesRelated("猫", "薛定谔的猫")).toBe(false); // 长度 < 2
  });
});

describe("Wikipedia API lookups", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches direct summary successfully and truncates long extract", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/page/summary/")) {
        return new Response(
          JSON.stringify({
            type: "standard",
            title: "马克斯·韦伯",
            extract: "马克斯·韦伯是德国著名的社会学家、历史学家和政治经济学家。".repeat(10),
            content_urls: { desktop: { page: "https://zh.wikipedia.org/wiki/马克斯·韦伯" } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    const res = await fetchWikipediaSummary("马克斯·韦伯", "zh", mockFetch as any);
    expect(res.status).toBe("found");
    if (res.status === "found") {
      expect(res.title).toBe("马克斯·韦伯");
      expect(res.url).toBe("https://zh.wikipedia.org/wiki/马克斯·韦伯");
      expect(res.summary.endsWith("…")).toBe(true);
      expect(res.summary.length).toBeLessThanOrEqual(225);
    }
  });

  it("rejects disambiguation page as not_found", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "disambiguation",
          title: "韦伯",
          extract: "韦伯可以指：卡尔·马利亚·冯·韦伯...",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const res = await fetchWikipediaSummary("韦伯", "zh", mockFetch as any);
    expect(res.status).toBe("not_found");
  });

  it("returns error status on 5xx or network exceptions", async () => {
    const mock500 = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const res500 = await fetchWikipediaSummary("马克斯·韦伯", "zh", mock500 as any);
    expect(res500.status).toBe("error");

    const mockNetworkError = vi.fn().mockRejectedValue(new Error("Connection reset"));
    const resError = await fetchWikipediaSummary("马克斯·韦伯", "zh", mockNetworkError as any);
    expect(resError.status).toBe("error");
  });

  it("falls back to search when direct lookup is disambiguation or 404", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/page/summary/%E9%9F%A6%E4%BC%AF")) {
        // 直查「韦伯」返回消歧义
        return new Response(JSON.stringify({ type: "disambiguation" }), { status: 200 });
      }
      if (url.includes("/w/api.php")) {
        // 搜索「韦伯」返回「马克斯·韦伯」
        return new Response(
          JSON.stringify({
            query: { search: [{ title: "马克斯·韦伯" }] },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/page/summary/%E9%A9%AC%E5%85%8B%E6%96%AF%C2%B7%E9%9F%A6%E4%BC%AF")) {
        return new Response(
          JSON.stringify({
            type: "standard",
            title: "马克斯·韦伯",
            extract: "德国社会学家与哲学家。",
            content_urls: { desktop: { page: "https://zh.wikipedia.org/wiki/马克斯·韦伯" } },
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    const res = await lookupConcept("韦伯", "zh", mockFetch as any);
    expect(res.status).toBe("found");
    if (res.status === "found") {
      expect(res.concept.term).toBe("韦伯");
      expect(res.concept.wikipedia_title).toBe("马克斯·韦伯");
      expect(res.concept.url).toBe("https://zh.wikipedia.org/wiki/马克斯·韦伯");
    }
  });

  it("deduplicates canonical titles and filters out not-found candidates", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("OpenAI")) {
        return new Response(
          JSON.stringify({
            type: "standard",
            title: "OpenAI",
            extract: "人工智能研究实验室。",
            content_urls: { desktop: { page: "https://zh.wikipedia.org/wiki/OpenAI" } },
          }),
          { status: 200 },
        );
      }
      // 其余词条 404
      return new Response(null, { status: 404 });
    });

    const candidates = ["OpenAI", "openai", "这是一个不存在的词条XYZ123"];
    const verified = await verifyConceptsWikipedia(candidates, { limit: 10, fetchFn: mockFetch as any });

    expect(verified.hasErrors).toBe(false);
    expect(verified.concepts).toHaveLength(1);
    expect(verified.concepts[0].wikipedia_title).toBe("OpenAI");
  });
});

describe("taskConcepts endpoint", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function createMockEnv(overrides: {
    task?: Record<string, unknown> | null;
    cachedConcepts?: string | null;
    githubMarkdown?: string;
    workerCandidates?: string[];
  } = {}): Env {
    const {
      task = {
        id: TASK_ID,
        status: "success",
        podcast_name: "忽左忽右",
        episode_title: "社会学经典导读",
        final_content_path: FINAL_PATH,
        content_commit_sha: COMMIT_SHA,
      },
      cachedConcepts = null,
      githubMarkdown = "# 正文\n\n马克斯·韦伯在《新教伦理与资本主义精神》中指出...",
      workerCandidates = ["马克斯·韦伯", "新教伦理与资本主义精神"],
    } = overrides;

    let savedCaches: Array<{ path: string; sha: string; lang: string; json: string }> = [];

    const mockDB = {
      prepare: (sql: string) => {
        const statement: Record<string, unknown> = {
          first: async () => null, // refiner_settings 等无 bind 的查询
        };
        statement.bind = (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes("FROM tasks")) return task;
            if (sql.includes("FROM article_concepts")) {
              const path = args[0] as string;
              const sha = args[1] as string;
              const lang = (args[2] as string | undefined) ?? "zh";
              if (cachedConcepts && path === FINAL_PATH && sha === COMMIT_SHA && lang === "zh") {
                return { concepts_json: cachedConcepts };
              }
              const matched = savedCaches.find(c => c.path === path && c.sha === sha && c.lang === lang);
              if (matched) return { concepts_json: matched.json };
              // Fallback if query didn't bind lang
              if (args.length === 2) {
                const fallback = savedCaches.find(c => c.path === path && c.sha === sha);
                if (fallback) return { concepts_json: fallback.json };
              }
              return null;
            }
            return null;
          },
          run: async () => {
            if (sql.includes("INSERT OR REPLACE INTO article_concepts")) {
              if (args.length >= 4) {
                const [path, sha, lang, jsonVal] = args as [string, string, string, string];
                savedCaches = savedCaches.filter(c => !(c.path === path && c.sha === sha && c.lang === lang));
                savedCaches.push({ path, sha, lang, json: jsonVal });
              } else {
                const [path, sha, jsonVal] = args as [string, string, string];
                savedCaches = savedCaches.filter(c => !(c.path === path && c.sha === sha && c.lang === "zh"));
                savedCaches.push({ path, sha, lang: "zh", json: jsonVal });
              }
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        });
        return statement;
      },
    };

    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      // GitHub contents API
      if (urlStr.includes("api.github.com/repos")) {
        return new Response(githubMarkdown, { status: 200 });
      }

      // Edge refiner（Cloudflare 侧直连 OpenAI 兼容 /chat/completions，不再经过 Mac）
      if (urlStr.includes("/chat/completions")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ concepts: workerCandidates }) }, finish_reason: "stop" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Wikipedia API
      if (urlStr.includes("/page/summary/")) {
        const decoded = decodeURIComponent(urlStr);
        if (decoded.includes("马克斯·韦伯") || decoded.includes("韦伯")) {
          return new Response(
            JSON.stringify({
              type: "standard",
              title: "马克斯·韦伯",
              extract: "德国社会学家、哲学家与政治经济学家。",
              content_urls: { desktop: { page: "https://zh.wikipedia.org/wiki/马克斯·韦伯" } },
            }),
            { status: 200 },
          );
        }
        if (decoded.includes("新教伦理与资本主义精神")) {
          return new Response(
            JSON.stringify({
              type: "standard",
              title: "新教伦理与资本主义精神",
              extract: "韦伯的社会学经典著作。",
              content_urls: { desktop: { page: "https://zh.wikipedia.org/wiki/新教伦理与资本主义精神" } },
            }),
            { status: 200 },
          );
        }
        if (decoded.includes("Max Weber") || decoded.includes("Max_Weber")) {
          return new Response(
            JSON.stringify({
              type: "standard",
              title: "Max Weber",
              extract: "German sociologist, historian and political economist.",
              content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Max_Weber" } },
            }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 404 });
      }

      return new Response(null, { status: 404 });
    });

    return {
      db: mockDB,
      DB: mockDB,
      manuscripts: {
        publish: vi.fn(),
        read: vi.fn(async () => githubMarkdown),
        list: vi.fn(async () => []),
      },
      GITHUB_TOKEN: "ghp-test",
      CONTROL_AUTH_MODE: "access",
      GITHUB_OWNER: "test-owner",
      GITHUB_REPO: "writing",
      GITHUB_BRANCH: "main",
      GITHUB_PODCAST_PATH: "podcasts/transcripts",
      REFINER_API_KEY: "test-refiner-key",
    } as unknown as Env;
  }

  it("returns 404 when task does not exist", async () => {
    const env = createMockEnv({ task: null });
    await expect(taskConcepts("non-existent-task", env)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("returns 409 when task is unfinished or running", async () => {
    const env = createMockEnv({
      task: { id: TASK_ID, status: "refining", final_content_path: null },
    });
    await expect(taskConcepts(TASK_ID, env)).rejects.toMatchObject({
      status: 409,
      code: "task_not_finished",
    });
  });

  it("returns 409 when task has no final_content_path", async () => {
    const env = createMockEnv({
      task: { id: TASK_ID, status: "success", final_content_path: null },
    });
    await expect(taskConcepts(TASK_ID, env)).rejects.toMatchObject({
      status: 409,
      code: "task_not_finished",
    });
  });

  it("hits D1 cache by commit_sha and returns immediately without fetching GitHub/Worker/Wikipedia", async () => {
    const cachedData = JSON.stringify({
      concepts: [
        {
          term: "马克斯·韦伯",
          wikipedia_title: "马克斯·韦伯",
          summary: "缓存中的韦伯摘要",
          url: "https://zh.wikipedia.org/wiki/马克斯·韦伯",
        },
      ],
    });

    const env = createMockEnv({ cachedConcepts: cachedData });
    const res = await taskConcepts(TASK_ID, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { concepts: Array<{ term: string }> };
    expect(body.concepts).toHaveLength(1);
    expect(body.concepts[0].term).toBe("马克斯·韦伯");

    // 确认由于命中缓存，没有对外发起任何 HTTP 请求
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("cache miss: fetches GitHub markdown, invokes Mac worker, verifies on Wikipedia, and stores in D1", async () => {
    const env = createMockEnv({ cachedConcepts: null });
    const res = await taskConcepts(TASK_ID, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { concepts: Array<{ term: string; wikipedia_title: string }> };
    expect(body.concepts.length).toBeGreaterThanOrEqual(1);
    expect(body.concepts.map(c => c.wikipedia_title)).toContain("马克斯·韦伯");

    // 再次调用，这次应该命中刚刚写入的 D1 缓存
    (globalThis.fetch as any).mockClear();
    const secondRes = await taskConcepts(TASK_ID, env);
    expect(secondRes.status).toBe(200);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("re-extracts when commit_sha changes (cache invalidation)", async () => {
    const env = createMockEnv({ cachedConcepts: null });

    // 第一次以 COMMIT_SHA 跑通并缓存
    await taskConcepts(TASK_ID, env);

    // 模拟 force rerun 产生了新的 COMMIT_SHA
    const newSha = "ffffffffffffffffffffffffffffffffffffffff";
    const updatedEnv = createMockEnv({
      task: {
        id: TASK_ID,
        status: "success",
        podcast_name: "忽左忽右",
        episode_title: "社会学经典导读",
        final_content_path: FINAL_PATH,
        content_commit_sha: newSha,
      },
    });

    (globalThis.fetch as any).mockClear();
    const res = await taskConcepts(TASK_ID, updatedEnv);
    expect(res.status).toBe(200);
    // 新 commit 触发了外部抽取流程，fetch 应该被再次调用
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("P1 guard: throws 502 and does NOT write D1 cache when Wikipedia encounters transient network/server errors", async () => {
    const env = createMockEnv({ cachedConcepts: null });

    // 模拟 Wikipedia 遭遇 503 临时不可用
    (globalThis.fetch as any).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("api.github.com/repos")) {
        return new Response("# 正文\n\n讨论了一些非常重要的概念...", { status: 200 });
      }
      if (urlStr.includes("/chat/completions")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ concepts: ["马克斯·韦伯", "卡尔·马克思"] }) } }] }),
          { status: 200 },
        );
      }
      if (urlStr.includes("wikipedia.org")) {
        return new Response(null, { status: 503 }); // 临时服务不可用
      }
      return new Response(null, { status: 404 });
    });

    // 必须抛出 502 异常，触发前端展示“重试”按钮
    await expect(taskConcepts(TASK_ID, env)).rejects.toMatchObject({
      status: 502,
      code: "wikipedia_unavailable",
    });

    // 验证 D1 缓存未被污染（再次调用不应命中缓存）
    const cachedRow = await env.db.prepare(
      "SELECT concepts_json FROM article_concepts WHERE content_path = ? AND commit_sha = ?"
    ).bind(FINAL_PATH, COMMIT_SHA).first();
    expect(cachedRow).toBeNull();
  });

  it("P1 guard: safely caches empty concepts in D1 when all candidates are genuine not_found (404/disambiguation)", async () => {
    const env = createMockEnv({ cachedConcepts: null });

    // 模拟候选词全部真实不在维基百科中（404 或消歧义）
    (globalThis.fetch as any).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("api.github.com/repos")) {
        return new Response("# 正文\n\n纯口语交流，无专有条目...", { status: 200 });
      }
      if (urlStr.includes("/chat/completions")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ concepts: ["自造词123", "某泛指词"] }) } }] }),
          { status: 200 },
        );
      }
      if (urlStr.includes("wikipedia.org")) {
        // 正常返回 404，表明条目确实不存在
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    });

    const res = await taskConcepts(TASK_ID, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { concepts: unknown[] };
    expect(body.concepts).toEqual([]);

    // 验证确实写入了 D1 空缓存，后续请求不再重复调用
    const cachedRow = await env.db.prepare(
      "SELECT concepts_json FROM article_concepts WHERE content_path = ? AND commit_sha = ?"
    ).bind(FINAL_PATH, COMMIT_SHA).first<{ concepts_json: string }>();
    expect(cachedRow).not.toBeNull();
    expect(JSON.parse(cachedRow!.concepts_json)).toEqual({ concepts: [] });
  });

  it("full route dispatch via worker.fetch: POST concepts works, assistant route returns 404", async () => {
    const env = createMockEnv({
      cachedConcepts: JSON.stringify({ concepts: [{ term: "韦伯", wikipedia_title: "马克斯·韦伯" }] }),
    });
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

    // 1. Concepts 接口正常响应
    const conceptReq = new Request(`https://example.com/api/control/tasks/${TASK_ID}/concepts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const conceptRes = await worker.fetch(conceptReq, env, ctx);
    expect(conceptRes.status).toBe(200);
    const data = (await conceptRes.json()) as { concepts: Array<{ term: string }> };
    expect(data.concepts[0].term).toBe("韦伯");

    // 2. Assistant 接口已在设计层面彻底删除，确认为 404
    const assistantReq = new Request("https://example.com/api/control/assistant", {
      method: "POST",
      body: JSON.stringify({ query: "介绍一下" }),
    });
    const assistantRes = await worker.fetch(assistantReq, env, ctx);
    expect(assistantRes.status).toBe(404);
  });

  it("supports lang=en and maintains bilingual cache separation", async () => {
    const env = createMockEnv({
      workerCandidates: ["Max Weber"],
    });

    // 1. zh 抽取
    const zhRes = await taskConcepts(TASK_ID, env, "zh");
    expect(zhRes.status).toBe(200);

    // 2. en 抽取：使用 en.wikipedia.org
    const enRes = await taskConcepts(TASK_ID, env, "en");
    expect(enRes.status).toBe(200);
    const enBody = (await enRes.json()) as { concepts: Array<{ term: string; wikipedia_title: string; url: string }> };
    expect(enBody.concepts).toHaveLength(1);
    expect(enBody.concepts[0].wikipedia_title).toBe("Max Weber");
    expect(enBody.concepts[0].url).toContain("en.wikipedia.org");

    // 3. 验证 D1 中两者独立缓存存在
    const zhCached = await env.db.prepare(
      "SELECT concepts_json FROM article_concepts WHERE content_path = ? AND commit_sha = ? AND lang = ?"
    ).bind(FINAL_PATH, COMMIT_SHA, "zh").first<{ concepts_json: string }>();
    expect(zhCached).not.toBeNull();

    const enCached = await env.db.prepare(
      "SELECT concepts_json FROM article_concepts WHERE content_path = ? AND commit_sha = ? AND lang = ?"
    ).bind(FINAL_PATH, COMMIT_SHA, "en").first<{ concepts_json: string }>();
    expect(enCached).not.toBeNull();
    expect(JSON.parse(enCached!.concepts_json).concepts[0].wikipedia_title).toBe("Max Weber");
  });

  it("Chinese transcript -> en concepts: extracts English Wikipedia entries from Chinese source text", async () => {
    const env = createMockEnv({
      githubMarkdown: "# 忽左忽右\n\n今天讨论社会学先驱马克斯·韦伯。",
      workerCandidates: ["Max Weber"],
    });

    const res = await taskConcepts(TASK_ID, env, "en");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { concepts: Array<{ term: string; wikipedia_title: string; url: string }> };
    expect(body.concepts).toHaveLength(1);
    expect(body.concepts[0].wikipedia_title).toBe("Max Weber");
    expect(body.concepts[0].url).toContain("en.wikipedia.org");
  });

  it("English transcript -> zh concepts: extracts Chinese Wikipedia entries from English source text", async () => {
    const env = createMockEnv({
      githubMarkdown: "# Sociology Weekly\n\nToday we examine the sociological contributions of Max Weber.",
      workerCandidates: ["马克斯·韦伯"],
    });

    const res = await taskConcepts(TASK_ID, env, "zh");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { concepts: Array<{ term: string; wikipedia_title: string; url: string }> };
    expect(body.concepts).toHaveLength(1);
    expect(body.concepts[0].wikipedia_title).toBe("马克斯·韦伯");
    expect(body.concepts[0].url).toContain("zh.wikipedia.org");
  });

  it("route dispatch supports ?lang=en for both control and public endpoints", async () => {
    const env = createMockEnv({
      cachedConcepts: JSON.stringify({ concepts: [{ term: "韦伯", wikipedia_title: "马克斯·韦伯" }] }),
    });
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

    // 预置 en 缓存
    await env.db.prepare(
      "INSERT OR REPLACE INTO article_concepts (content_path, commit_sha, lang, concepts_json) VALUES (?, ?, ?, ?)"
    ).bind(FINAL_PATH, COMMIT_SHA, "en", JSON.stringify({ concepts: [{ term: "Max Weber", wikipedia_title: "Max Weber" }] })).run();

    // 1. Control POST with ?lang=en
    const controlReq = new Request(`https://example.com/api/control/tasks/${TASK_ID}/concepts?lang=en`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const controlRes = await worker.fetch(controlReq, env, ctx);
    expect(controlRes.status).toBe(200);
    const controlData = (await controlRes.json()) as { concepts: Array<{ term: string }> };
    expect(controlData.concepts[0].term).toBe("Max Weber");

    // 2. Public GET with ?lang=en
    // mock published content for public endpoint
    const mockTask = {
      id: TASK_ID,
      status: "success",
      podcast_name: "忽左忽右",
      episode_title: "社会学经典导读",
      final_content_path: FINAL_PATH,
      content_commit_sha: COMMIT_SHA,
    };
    const origPrepare = env.db.prepare.bind(env.db);
    (env.db as any).prepare = (sql: string) => {
      const orig = origPrepare(sql);
      return {
        ...orig,
        bind: (...args: unknown[]) => {
          const bound = orig.bind(...args);
          return {
            ...bound,
            first: async () => {
              if (sql.includes("FROM articles")) {
                return { title: "社会学经典导读", content_path: FINAL_PATH, commit_sha: COMMIT_SHA };
              }
              return bound.first();
            },
          };
        },
      };
    };

    const publicReq = new Request(`https://example.com/api/public/articles/${TASK_ID}/concepts?lang=en`, {
      method: "GET",
    });
    const publicRes = await worker.fetch(publicReq, env, ctx);
    expect(publicRes.status).toBe(200);
    const publicData = (await publicRes.json()) as { concepts: Array<{ term: string }> };
    expect(publicData.concepts[0].term).toBe("Max Weber");
  });
});
