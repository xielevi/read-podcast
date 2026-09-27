import { describe, expect, it, vi } from "vitest";
import {
  artwork,
  assertPublicHttpUrl,
  getReadState,
  putReadState,
  searchPodcast,
} from "../src/episodes";
import type { Env } from "../src/types";

const PODCAST = "忽左忽右";
const RSS_URL = "https://example.com/feed.xml";

describe("assertPublicHttpUrl SSRF & CIDR validation", () => {
  it("rejects non-HTTP protocols and credentials", () => {
    expect(() => assertPublicHttpUrl("ftp://example.com/feed.xml")).toThrow("URL must be HTTP(S)");
    expect(() => assertPublicHttpUrl("http://admin:pass@example.com/feed.xml")).toThrow("without credentials");
    expect(() => assertPublicHttpUrl("not-a-url")).toThrow("URL must be absolute");
  });

  it("blocks local hostnames and domains", () => {
    expect(() => assertPublicHttpUrl("http://localhost/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://service.local/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://node.internal/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://app.localhost/feed.xml")).toThrow("non-public host");
  });

  it("blocks private IPv4 ranges (RFC 1918, CGNAT, link-local, benchmark, multicast, reserved)", () => {
    // 127.0.0.0/8
    expect(() => assertPublicHttpUrl("http://127.0.0.1/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://127.1.2.3/feed.xml")).toThrow("non-public host");
    // 10.0.0.0/8
    expect(() => assertPublicHttpUrl("http://10.0.0.1/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://10.255.255.254/feed.xml")).toThrow("non-public host");
    // 172.16.0.0/12 (172.16 - 172.31)
    expect(() => assertPublicHttpUrl("http://172.16.0.1/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://172.31.255.255/feed.xml")).toThrow("non-public host");
    expect(assertPublicHttpUrl("http://172.32.0.1/feed.xml").hostname).toBe("172.32.0.1");
    // 192.168.0.0/16
    expect(() => assertPublicHttpUrl("http://192.168.1.1/feed.xml")).toThrow("non-public host");
    // 100.64.0.0/10 CGNAT (100.64 - 100.127)
    expect(() => assertPublicHttpUrl("http://100.64.0.1/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://100.127.255.255/feed.xml")).toThrow("non-public host");
    expect(assertPublicHttpUrl("http://100.128.0.1/feed.xml").hostname).toBe("100.128.0.1");
    // 169.254.0.0/16 link-local
    expect(() => assertPublicHttpUrl("http://169.254.1.1/feed.xml")).toThrow("non-public host");
    // 198.18.0.0/15 benchmark (198.18 - 198.19)
    expect(() => assertPublicHttpUrl("http://198.18.0.1/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://198.19.255.255/feed.xml")).toThrow("non-public host");
    expect(assertPublicHttpUrl("http://198.20.0.1/feed.xml").hostname).toBe("198.20.0.1");
    // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved
    expect(() => assertPublicHttpUrl("http://224.0.0.1/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://240.0.0.1/feed.xml")).toThrow("non-public host");
  });

  it("blocks private IPv6 ranges (loopback, link-local, ULA, multicast, IPv4-mapped)", () => {
    expect(() => assertPublicHttpUrl("http://[::1]/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://[fe80::1]/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://[fc00::1]/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://[fd12:3456:789a::1]/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://[ff02::1]/feed.xml")).toThrow("non-public host");
    // IPv4-mapped private
    expect(() => assertPublicHttpUrl("http://[::ffff:127.0.0.1]/feed.xml")).toThrow("non-public host");
    expect(() => assertPublicHttpUrl("http://[::ffff:192.168.1.1]/feed.xml")).toThrow("non-public host");
    // IPv4-mapped public is allowed
    expect(assertPublicHttpUrl("http://[::ffff:8.8.8.8]/feed.xml")).toBeDefined();
  });

  it("hostnames that merely start with fc / fd / fe8 / ff are not mistaken for IPv6 ranges", () => {
    for (const url of ["https://fcc.example.com/feed.xml", "https://fdroid.example.org/feed.xml", "https://fe80s.example.net/feed.xml", "https://ffm.example.com/feed.xml"]) {
      expect(assertPublicHttpUrl(url).toString(), url).toBe(url);
    }
  });

  it("shares the audio-source rules: documentation ranges, NAT64 / 6to4 and single-label hosts are rejected", () => {
    for (const url of ["http://192.0.2.1/feed.xml", "http://203.0.113.9/feed.xml", "http://[64:ff9b::7f00:1]/feed.xml", "http://[2002:7f00:1::1]/feed.xml", "http://intranet/feed.xml", "http://router.lan/feed.xml"]) {
      expect(() => assertPublicHttpUrl(url), url).toThrow("non-public host");
    }
  });

  it("allows valid public hostnames and IP addresses", () => {
    expect(assertPublicHttpUrl("https://feeds.example.com/podcast.xml").hostname).toBe("feeds.example.com");
    expect(assertPublicHttpUrl("http://8.8.8.8/feed.xml").hostname).toBe("8.8.8.8");
    expect(assertPublicHttpUrl("https://1.1.1.1/feed.xml").hostname).toBe("1.1.1.1");
  });
});

describe("artwork proxy bounded fetch", () => {
  it("rejects non-public artwork URL", async () => {
    const env = {} as Env;
    const url = new URL("https://edge.test/api/control/artwork?url=http://127.0.0.1/test.png");
    await expect(artwork(url, env)).rejects.toThrow("URL resolves to a non-public host");
  });

  it("rejects unsupported media content type", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("<html>bad</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );
    try {
      const env = {} as Env;
      const url = new URL("https://edge.test/api/control/artwork?url=https://example.com/bad.html");
      const res = await artwork(url, env);
      expect(res.status).toBe(415);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects artwork exceeding 5MB via Content-Length", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(10), {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(6 * 1024 * 1024),
        },
      })
    );
    try {
      const env = {} as Env;
      const url = new URL("https://edge.test/api/control/artwork?url=https://example.com/huge.jpg");
      const res = await artwork(url, env);
      expect(res.status).toBe(413);
      const data = await res.json() as any;
      expect(data.error.code).toBe("artwork_too_large");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("proxies valid artwork under 5MB", async () => {
    const originalFetch = globalThis.fetch;
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(imageBytes, {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(imageBytes.byteLength),
        },
      })
    );
    try {
      const env = {} as Env;
      const url = new URL("https://edge.test/api/control/artwork?url=https://example.com/valid.jpg");
      const res = await artwork(url, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      const arrayBuffer = await res.arrayBuffer();
      expect(new Uint8Array(arrayBuffer)).toEqual(imageBytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── searchPodcast / 已读端点 ──

/** 在受控 fetch 下运行，结束后还原，避免影响同文件其它用例。 */
async function withFetch<T>(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = impl as typeof globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = saved;
  }
}

/** 只记录 SQL / 绑定参数的最小 D1 fake（read_state 与 subscriptions 形状不同，单独建）。 */
function mockReadStateEnv(options: { rows?: Array<{ episode_id: string | null; task_id: string | null }> } = {}) {
  const calls = { sql: [] as string[], bound: [] as unknown[][] };
  const db = {
    prepare(sql: string) {
      calls.sql.push(sql);
      const bound: unknown[] = [];
      calls.bound.push(bound);
      const statement = {
        bind: (...args: unknown[]) => {
          bound.push(...args);
          return statement;
        },
        all: async () => ({ results: options.rows ?? [] }),
        run: async () => ({ meta: { changes: 1 } }),
        first: async () => null,
      };
      return statement;
    },
  };
  return { env: { DB: db } as unknown as Env, calls };
}

function itunesResponse(results: Array<Record<string, unknown>>, status = 200): Response {
  return new Response(JSON.stringify({ results }), { status, headers: { "content-type": "application/json" } });
}

describe("searchPodcast (iTunes)", () => {
  it("空 q 直接返回空数组且不发起上游请求", async () => {
    const { env } = mockReadStateEnv();
    const fetchSpy = vi.fn();
    const res = await withFetch(fetchSpy, () => searchPodcast(new URL("https://edge.test/api/control/search/podcast?q=%20"), env));
    expect(await res.json()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("请求体带 term / media=podcast / limit=25", async () => {
    const { env } = mockReadStateEnv();
    let called = "";
    const res = await withFetch(
      async (input) => {
        called = String(input);
        return itunesResponse([]);
      },
      () => searchPodcast(new URL("https://edge.test/api/control/search/podcast?q=忽左忽右"), env),
    );
    expect(await res.json()).toEqual([]);
    const url = new URL(called);
    expect(url.origin + url.pathname).toBe("https://itunes.apple.com/search");
    expect(url.searchParams.get("term")).toBe("忽左忽右");
    expect(url.searchParams.get("media")).toBe("podcast");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("映射为 name / rss_url / image / author，并丢弃没有 feedUrl 的结果", async () => {
    const { env } = mockReadStateEnv();
    const res = await withFetch(
      async () =>
        itunesResponse([
          {
            collectionName: "忽左忽右",
            feedUrl: "https://example.com/feed.xml",
            artworkUrl600: "https://example.com/600.jpg",
            artworkUrl100: "https://example.com/100.jpg",
            artistName: "JustPod",
          },
          // 无 feedUrl → 必须被过滤
          { collectionName: "无源节目", artworkUrl100: "https://example.com/x.jpg" },
          // 只有 trackName、只有 artworkUrl100 → 走 ?? 回退
          { trackName: "备用取名", feedUrl: "https://example.com/b.xml", artworkUrl100: "https://example.com/100b.jpg" },
        ]),
      () => searchPodcast(new URL("https://edge.test/api/control/search/podcast?q=x"), env),
    );

    expect(await res.json()).toEqual([
      {
        name: "忽左忽右",
        rss_url: "https://example.com/feed.xml",
        image: "https://example.com/600.jpg",
        author: "JustPod",
      },
      { name: "备用取名", rss_url: "https://example.com/b.xml", image: "https://example.com/100b.jpg", author: "" },
    ]);
  });

  it("上游非 2xx → 502 search_failed", async () => {
    const { env } = mockReadStateEnv();
    await expect(
      withFetch(async () => itunesResponse([], 503), () =>
        searchPodcast(new URL("https://edge.test/api/control/search/podcast?q=x"), env),
      ),
    ).rejects.toMatchObject({ status: 502, code: "search_failed" });
  });

  it("results 缺失时返回空数组而不是抛错", async () => {
    const { env } = mockReadStateEnv();
    const res = await withFetch(
      async () => new Response(JSON.stringify({}), { status: 200 }),
      () => searchPodcast(new URL("https://edge.test/api/control/search/podcast?q=x"), env),
    );
    expect(await res.json()).toEqual([]);
  });
});

describe("read state 端点（按 episode_id / task_id 记，见迁移 0020）", () => {
  const putRequest = (body: unknown) =>
    new Request("https://edge.test/api/control/episodes/read", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("getReadState：返回稳定身份（单集 episode_id 或导入稿件 task_id）", async () => {
    const { env } = mockReadStateEnv({
      rows: [
        { episode_id: "1:475", task_id: null },
        { episode_id: null, task_id: "t-upload" },
      ],
    });
    const res = await getReadState(new URL("https://edge.test/api/control/episodes/read"), env);
    expect(await res.json()).toEqual({
      items: [{ episode_id: "1:475", task_id: null }, { episode_id: null, task_id: "t-upload" }],
      next_offset: null,
    });
  });

  it("getReadState：返回行数超过 limit 时给出 next_offset，且丢弃多取的那一行", async () => {
    const { env, calls } = mockReadStateEnv({
      rows: [
        { episode_id: "1:a", task_id: null },
        { episode_id: "1:b", task_id: null },
        { episode_id: "1:c", task_id: null },
      ],
    });
    const res = await getReadState(new URL("https://edge.test/api/control/episodes/read?limit=2&offset=4"), env);
    expect(await res.json()).toEqual({ items: [{ episode_id: "1:a", task_id: null }, { episode_id: "1:b", task_id: null }], next_offset: 6 });
    // 多取一行用于判断 hasMore
    expect(calls.bound[0]).toEqual([3, 4]);
  });

  it("getReadState：limit 钳制到 [1,500]，非法值回退 200", async () => {
    const cases: Array<[string, number]> = [
      ["limit=9999", 500],
      ["limit=0", 1],
      ["limit=-5", 1],
      ["limit=abc", 200],
      ["", 200],
    ];
    for (const [query, expected] of cases) {
      const { env, calls } = mockReadStateEnv({ rows: [] });
      await getReadState(new URL(`https://edge.test/api/control/episodes/read?${query}`), env);
      expect(calls.bound[0][0], query || "(缺省)").toBe(expected + 1);
    }
  });

  it("getReadState：负 offset 与非数字 offset 都归零（不把 NaN 绑定进 D1）", async () => {
    for (const query of ["offset=-3", "offset=abc"]) {
      const { env, calls } = mockReadStateEnv({ rows: [] });
      await getReadState(new URL(`https://edge.test/api/control/episodes/read?${query}`), env);
      expect(calls.bound[0][1], query).toBe(0);
    }
  });

  it("putReadState：episode_id + read=true 按 episode_id upsert", async () => {
    const { env, calls } = mockReadStateEnv();
    expect(await (await putReadState(putRequest({ episode_id: "1:475", read: true }), env)).json()).toEqual({ ok: true });
    expect(calls.sql[0]).toContain("INSERT INTO read_state (episode_id");
    expect(calls.sql[0]).toContain("ON CONFLICT(episode_id) DO UPDATE");
    expect(calls.bound[0]).toEqual(["1:475"]);
  });

  it("putReadState：导入音频的稿件按 task_id 记；read=false / 缺省走删除", async () => {
    const { env, calls } = mockReadStateEnv();
    await putReadState(putRequest({ task_id: "t-upload", read: true }), env);
    await putReadState(putRequest({ task_id: "t-upload", read: false }), env);
    await putReadState(putRequest({ episode_id: "1:475" }), env);
    expect(calls.sql[0]).toContain("ON CONFLICT(task_id) DO UPDATE");
    expect(calls.sql[1]).toBe("DELETE FROM read_state WHERE task_id = ?");
    expect(calls.sql[2]).toBe("DELETE FROM read_state WHERE episode_id = ?");
  });

  it("putReadState：episode_id 与 task_id 必须恰好给一个 → 否则 400", async () => {
    const { env } = mockReadStateEnv();
    for (const body of [{}, { episode_id: "  " }, { episode_id: "1:a", task_id: "t" }, { podcast_name: "a", episode_title: "b" }]) {
      await expect(putReadState(putRequest(body), env), JSON.stringify(body)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
  });
});
