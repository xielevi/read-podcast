/**
 * Notion + R2 Manuscript Store：后端选择、可配置字段、R2 快照、失败后仍可发布、定时重试。
 */
import { afterEach, describe, expect, it } from "vitest";
import { assembleManuscriptStore } from "../src/platform/cloudflare";
import { notionManuscriptStoreEnabled, resolveManuscriptBackend } from "../src/manuscript_backend";
import { NOTION_SCHEMA_EN, NOTION_SCHEMA_ZH, resolveNotionSchema } from "../src/notion_schema";
import {
  NOTION_CHUNK_BYTES,
  buildNotionProperties,
  chunkMarkdown,
  createNotionR2ManuscriptStore,
  resolveManuscriptSnapshot,
  retryPendingNotionManuscripts,
} from "../src/notion_manuscript";
import type { ObjectStore } from "../src/platform/types";
import type { Env } from "../src/types";

const DATA_SOURCE = "00000000-0000-4000-8000-000000000001";
const PAGE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const MARKDOWN = "---\ntitle: Test episode\npodcast: Test Show\ndate: 2026-05-19\nduration: 01:02:03\nlink: https://cdn.example.com/a.mp3\nsource_link: https://example.com/ep\nprocessed_at: 2026-05-20 08:00:00\nrefinement_success: true\ntranscript_source: ai_refined\nbrief: {\"tldr\":\"one line\",\"reading_minutes\":12}\n---\n\n# Body\n";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function memoryStorage(): { objects: Map<string, string>; storage: ObjectStore } {
  const objects = new Map<string, string>();
  const storage: ObjectStore = {
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return { key, size: value.length, text: async () => value, body: null };
    },
    async put(key, value) {
      const text = typeof value === "string" ? value : new TextDecoder().decode(value as Uint8Array);
      objects.set(key, text);
      return { key, size: text.length };
    },
    async delete() {},
    async head(key) {
      const value = objects.get(key);
      return value === undefined ? null : { key, size: value.length };
    },
    async list() {
      return { objects: [] };
    },
  };
  return { objects, storage };
}

function notionEnv(storage: ObjectStore, extra: Partial<Env> = {}): Env {
  return {
    storage,
    MANUSCRIPT_STORE: "notion-r2",
    NOTION_TOKEN: "secret_test",
    NOTION_PODCAST_DATA_SOURCE_ID: DATA_SOURCE,
    TRANSCRIPTION_PROVIDER: "dashscope",
    MANUSCRIPT_PUBLIC_ORIGIN: "https://read.example",
    APP_ENV: "test",
    ...extra,
  } as Env;
}

interface Call { url: string; method: string; body: any; authorization: string | null; version: string | null }

function installFetch(handler: (call: Call, state: { pageHash: string }) => { status?: number; body: unknown } | Response) {
  const calls: Call[] = [];
  const state = { pageHash: "" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.get("authorization"),
      version: headers.get("notion-version"),
    };
    calls.push(call);
    const result = handler(call, state);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

function publishInput(markdown = MARKDOWN) {
  return {
    writingFilename: "20260519_Test_Show_episode",
    title: "Test episode",
    markdown,
    meta: { taskId: "task-1", episodeId: "ep-1", podcastName: "Test Show" },
  };
}

describe("resolveManuscriptBackend", () => {
  it("Cloudflare 缺省 github；只有显式选择才用 notion-r2", () => {
    expect(resolveManuscriptBackend({}, { platform: "cloudflare" })).toBe("github");
    expect(resolveManuscriptBackend({ NOTION_TOKEN: "t", NOTION_PODCAST_DATA_SOURCE_ID: DATA_SOURCE }, { platform: "cloudflare" })).toBe("github");
    expect(resolveManuscriptBackend({ MANUSCRIPT_STORE: "notion-r2" }, { platform: "cloudflare" })).toBe("notion-r2");
    expect(resolveManuscriptBackend({ NOTION_MANUSCRIPT_STORE: "true" }, { platform: "cloudflare" })).toBe("notion-r2");
    expect(resolveManuscriptBackend({ MANUSCRIPT_STORE: "github", NOTION_MANUSCRIPT_STORE: "true" }, { platform: "cloudflare" })).toBe("github");
    expect(resolveManuscriptBackend({ MANUSCRIPT_STORE: "local" }, { platform: "cloudflare" })).toBe("github");
    expect(notionManuscriptStoreEnabled({})).toBe(false);
    expect(notionManuscriptStoreEnabled({ MANUSCRIPT_STORE: "notion-r2" })).toBe(true);
  });

  it("Docker 有本地目录时缺省 local", () => {
    expect(resolveManuscriptBackend({}, { platform: "node", localDir: "/data/manuscripts" })).toBe("local");
    expect(resolveManuscriptBackend({ MANUSCRIPT_STORE: "github" }, { platform: "node", localDir: "/data/manuscripts" })).toBe("github");
    expect(resolveManuscriptBackend({ NOTION_MANUSCRIPT_STORE: "false" }, { platform: "node", localDir: "/data/manuscripts" })).toBe("local");
    expect(resolveManuscriptBackend({ MANUSCRIPT_STORE: "notion-r2" }, { platform: "node", localDir: "/data/manuscripts" })).toBe("notion-r2");
  });
});

describe("resolveNotionSchema", () => {
  it("默认是推荐中文模板，节目名列表为空", () => {
    const schema = resolveNotionSchema();
    expect(schema.properties.title).toBe("标题");
    expect(schema.properties.hash).toBe("内容哈希");
    expect(schema.status.published).toBe("已发布");
    expect(schema.shows).toEqual([]);
    expect(schema.showOther).toBe("其他");
  });

  it("en 模板与 JSON / 节目列表覆盖", () => {
    expect(resolveNotionSchema({ NOTION_SCHEMA: "en" }).properties.title).toBe("Title");
    const custom = resolveNotionSchema({
      NOTION_SCHEMA: "en",
      NOTION_PROPERTY_MAP: JSON.stringify({ hash: "SHA" }),
      NOTION_SHOW_OPTIONS: "Test Show, Another Show",
      NOTION_SHOW_OTHER: "Misc",
    });
    expect(custom.properties.hash).toBe("SHA");
    expect(custom.properties.title).toBe("Title");
    expect(custom.shows).toEqual(["Test Show", "Another Show"]);
    expect(custom.showOther).toBe("Misc");
  });

  it("缺少必填逻辑字段时失败", () => {
    expect(() => resolveNotionSchema({ NOTION_PROPERTY_MAP: JSON.stringify({ title: "" }) })).toThrow(/title/);
  });
});

describe("chunkMarkdown / properties", () => {
  it("短文不拆；超限时优先在空行切开", () => {
    expect(chunkMarkdown("hello", 80_000)).toEqual(["hello"]);
    const text = `${"a".repeat(50_000)}\n\n${"b".repeat(50_000)}`;
    const chunks = chunkMarkdown(text, NOTION_CHUNK_BYTES);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].endsWith("a")).toBe(true);
    expect(chunks[1].startsWith("b")).toBe(true);
    expect(chunks.every(chunk => new TextEncoder().encode(chunk).byteLength <= NOTION_CHUNK_BYTES)).toBe(true);
  });

  it("默认中文模板写入推荐字段；未知节目落到 other", () => {
    const env = notionEnv(memoryStorage().storage);
    const snapshot = resolveManuscriptSnapshot(env, publishInput());
    const properties = buildNotionProperties(env, snapshot, "abc");
    expect(properties[NOTION_SCHEMA_ZH.properties.title]).toEqual({ title: [{ type: "text", text: { content: "Test episode" } }] });
    expect(properties[NOTION_SCHEMA_ZH.properties.show]).toEqual({ select: { name: "其他" } });
    expect(properties[NOTION_SCHEMA_ZH.properties.duration]).toEqual({ number: 3723 });
    expect(properties[NOTION_SCHEMA_ZH.properties.hash]).toEqual({ rich_text: [{ type: "text", text: { content: "abc" } }] });
    expect(properties[NOTION_SCHEMA_ZH.properties.status]).toEqual({ select: { name: "已发布" } });
    expect(properties[NOTION_SCHEMA_ZH.properties.taskId]).toEqual({ rich_text: [{ type: "text", text: { content: "task-1" } }] });
    expect(properties[NOTION_SCHEMA_ZH.properties.readingPage]).toEqual({ url: "https://read.example/a/task-1" });
  });

  it("英文模板 + 节目列表把已知节目写入 Show", () => {
    const env = notionEnv(memoryStorage().storage, { NOTION_SCHEMA: "en", NOTION_SHOW_OPTIONS: "Test Show" });
    const properties = buildNotionProperties(env, resolveManuscriptSnapshot(env, publishInput()), "abc");
    expect(properties[NOTION_SCHEMA_EN.properties.title]).toBeDefined();
    expect(properties[NOTION_SCHEMA_EN.properties.show]).toEqual({ select: { name: "Test Show" } });
    expect(properties[NOTION_SCHEMA_EN.properties.status]).toEqual({ select: { name: "Published" } });
    expect(properties[NOTION_SCHEMA_EN.properties.hash]).toEqual({ rich_text: [{ type: "text", text: { content: "abc" } }] });
    expect(properties["标题"]).toBeUndefined();
  });
});

describe("createNotionR2ManuscriptStore", () => {
  it("写入快照并创建 Notion 页，返回页 id 与 sha256", async () => {
    const { objects, storage } = memoryStorage();
    const calls = installFetch(call => {
      expect(call.authorization).toBe("Bearer secret_test");
      expect(call.version).toBe("2026-03-11");
      if (call.url.endsWith("/query")) return { body: { results: [] } };
      if (call.method === "POST" && call.url.endsWith("/v1/pages")) {
        expect(call.body.parent.data_source_id).toBe(DATA_SOURCE);
        expect(call.body.markdown).toContain("# Body");
        return { body: { object: "page", id: PAGE } };
      }
      expect(call.body.properties[NOTION_SCHEMA_ZH.properties.hash].rich_text[0].text.content).toMatch(/^[0-9a-f]{64}$/);
      return { body: { object: "page", id: PAGE } };
    });
    const published = await createNotionR2ManuscriptStore(notionEnv(storage)).publish(publishInput());
    expect(published).toMatchObject({ path: PAGE, notionPending: false });
    expect(published.version).toMatch(/^[0-9a-f]{64}$/);
    expect(objects.get(`manuscripts/${published.version}.md`)).toBe(MARKDOWN);
    expect(calls.some(call => call.url.includes("api.notion.com"))).toBe(true);
  });

  it("同内容重放不新建页面", async () => {
    const { storage } = memoryStorage();
    let hash = "";
    const calls = installFetch(call => {
      if (call.url.endsWith("/query")) {
        return { body: { results: hash ? [{ object: "page", id: PAGE, properties: { task_id: { rich_text: [{ plain_text: "task-1" }] }, [NOTION_SCHEMA_ZH.properties.hash]: { rich_text: [{ plain_text: hash }] } } }] : [] } };
      }
      if (call.method === "POST") return { body: { object: "page", id: PAGE } };
      hash = call.body.properties[NOTION_SCHEMA_ZH.properties.hash].rich_text[0].text.content;
      return { body: { object: "page", id: PAGE } };
    });
    const store = createNotionR2ManuscriptStore(notionEnv(storage));
    const first = await store.publish(publishInput());
    const before = calls.length;
    const second = await store.publish(publishInput());
    expect(second).toEqual(first);
    expect(calls.slice(before).some(call => call.method === "POST" && call.url.endsWith("/v1/pages"))).toBe(false);
    expect(calls.slice(before).some(call => call.url.includes("/markdown"))).toBe(false);
  });

  it("Notion 失败时保留快照并标记待同步", async () => {
    const { objects, storage } = memoryStorage();
    installFetch(() => ({ status: 500, body: { message: "unavailable" } }));
    const published = await createNotionR2ManuscriptStore(notionEnv(storage)).publish(publishInput());
    expect(published.notionPending).toBe(true);
    expect(published.path).toBe(`manuscripts/${published.version}.md`);
    expect(objects.get(published.path)).toBe(MARKDOWN);
  });

  it("未配置 token 时在写快照之前失败", async () => {
    const { objects, storage } = memoryStorage();
    installFetch(() => ({ body: {} }));
    await expect(createNotionR2ManuscriptStore(notionEnv(storage, { NOTION_TOKEN: "" })).publish(publishInput())).rejects.toThrow(/NOTION_TOKEN/);
    expect(objects.size).toBe(0);
  });

  it("公开快照按 sha 读对象存储；控制面当前正文读 Notion", async () => {
    const { storage } = memoryStorage();
    installFetch(call => {
      if (call.url.endsWith("/query")) return { body: { results: [] } };
      if (call.method === "POST") return { body: { object: "page", id: PAGE } };
      if (call.url.endsWith("/markdown") && call.method === "GET") return { body: { object: "page_markdown", markdown: "# edited" } };
      return { body: { object: "page", id: PAGE } };
    });
    const store = createNotionR2ManuscriptStore(notionEnv(storage));
    const published = await store.publish(publishInput());
    expect(await store.read(PAGE, published.version)).toBe(MARKDOWN);
    expect(await store.read(PAGE)).toBe("# edited");
    expect(await store.read(PAGE, "f".repeat(64))).toBeNull();
  });

  it("超长正文拆段，并在 allow_async 返回后轮询", async () => {
    const { storage } = memoryStorage();
    const markdown = `${"para-a".repeat(20_000)}\n\n${"para-b".repeat(20_000)}`;
    const calls = installFetch(call => {
      if (call.url.endsWith("/query")) return { body: { results: [] } };
      if (call.url.includes("/async_tasks/")) return { body: { object: "async_task", id: "task_abc", status: "succeeded", result: { object: "page", id: PAGE } } };
      if (call.method === "POST" && call.url.endsWith("/v1/pages")) {
        expect(call.body.allow_async).toBe(true);
        expect(call.body.markdown.length).toBeLessThan(markdown.length);
        return { status: 202, body: { object: "async_task", id: "task_abc", status: "queued", poll_after_seconds: 0 } };
      }
      if (call.url.endsWith("/markdown")) {
        expect(call.body.type).toBe("insert_content");
        return { body: { object: "page_markdown", id: PAGE } };
      }
      return { body: { object: "page", id: PAGE } };
    });
    const published = await createNotionR2ManuscriptStore(notionEnv(storage)).publish(publishInput(markdown));
    expect(published.path).toBe(PAGE);
    expect(calls.some(call => call.url.includes("/async_tasks/task_abc"))).toBe(true);
  });

  it("list 查询已发布页并按 path 排序", async () => {
    const { storage } = memoryStorage();
    installFetch(call => {
      expect(call.body.filter).toEqual({ property: "状态", select: { equals: "已发布" } });
      return { body: { results: [
        { object: "page", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", properties: { [NOTION_SCHEMA_ZH.properties.hash]: { rich_text: [{ plain_text: "bbb" }] } } },
        { object: "page", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", properties: { [NOTION_SCHEMA_ZH.properties.hash]: { rich_text: [{ plain_text: "AAA" }] } } },
      ], has_more: false } };
    });
    const listed = await createNotionR2ManuscriptStore(notionEnv(storage)).list();
    expect(listed.map(item => item.path)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    expect(listed[0].version).toBe("aaa");
  });
});

describe("retryPendingNotionManuscripts", () => {
  it("未选择 notion-r2 时不查询；待同步行成功后改成页 id", async () => {
    const { storage } = memoryStorage();
    const env = notionEnv(storage, { MANUSCRIPT_STORE: "github" });
    expect(await retryPendingNotionManuscripts(env)).toBe(0);

    env.MANUSCRIPT_STORE = "notion-r2";
    installFetch(() => ({ status: 503, body: { message: "down" } }));
    const published = await createNotionR2ManuscriptStore(env).publish(publishInput());
    expect(published.notionPending).toBe(true);

    const updates: string[] = [];
    env.db = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const statement = {
          bind(...args: unknown[]) {
            bound = args;
            return statement;
          },
          async all() {
            return { results: [{
              task_id: "task-1",
              episode_id: "ep-1",
              title: "Test episode",
              podcast_name: "Test Show",
              content_path: published.path,
              commit_sha: published.version,
              brief: null,
              audio_url: null,
            }] };
          },
          async run() {
            updates.push(`${sql} ${JSON.stringify(bound)}`);
            return { meta: { changes: 1 } };
          },
          async first() { return null; },
        };
        return statement as any;
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
    } as Env["db"];

    installFetch(call => {
      if (call.url.endsWith("/query")) return { body: { results: [] } };
      if (call.method === "POST") return { body: { object: "page", id: PAGE } };
      return { body: { object: "page", id: PAGE } };
    });
    expect(await retryPendingNotionManuscripts(env)).toBe(1);
    expect(updates.some(sql => sql.includes("notion_sync_pending = 0") && sql.includes(PAGE))).toBe(true);
  });
});

describe("GitHub 旧快照回落", () => {
  it("64 位哈希只读对象存储；仓库路径仍读 GitHub", async () => {
    const { objects, storage } = memoryStorage();
    objects.set(`manuscripts/${"ab".repeat(32)}.md`, "# snapshot");
    const calls = installFetch(call => {
      if (call.url.includes("api.github.com")) return new Response("# legacy", { status: 200 });
      throw new Error(`unexpected ${call.url}`);
    });
    const store = assembleManuscriptStore(notionEnv(storage, {
      GITHUB_TOKEN: "gh",
      GITHUB_OWNER: "OWNER",
      GITHUB_REPO: "REPO",
      GITHUB_BRANCH: "main",
      GITHUB_PODCAST_PATH: "podcasts/transcripts",
    }));
    expect(await store.read("ignored", "ab".repeat(32))).toBe("# snapshot");
    expect(calls).toEqual([]);
    expect(await store.read("podcasts/transcripts/old.md", "c".repeat(40))).toBe("# legacy");
    expect(calls[0].url).toContain("api.github.com");
  });
});
