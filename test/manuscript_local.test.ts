/**
 * 本地目录稿件存储(Canonical Manuscript Store 的 Docker 实现,#28)。
 *
 * 覆盖:
 *   - 发布落盘:当前文件内容逐字节一致,version = sha256(markdown) hex;
 *   - 命名与 GitHub 实现同构(manuscriptRelativePath / podcastPaths);
 *   - 覆盖发布保留历史版本(.versions/ 内容寻址快照),发布快照读取语义;
 *   - 同内容发布幂等(重放安全);
 *   - read 缺失语义(null)、版本解析与自愈;
 *   - 路径安全:writingFilename 规范化、path / version 防目录穿越;
 *   - list() 形态。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalManuscriptStore } from "../src/platform/node/manuscript";
import { podcastPaths } from "../src/github";
import type { Env } from "../src/types";

const TEST_DIR = resolve(process.cwd(), "data/test-manuscript-local");

const sha256 = (content: string): string => createHash("sha256").update(content, "utf-8").digest("hex");

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function makeStore(podcastPath?: string) {
  const store = createLocalManuscriptStore({ rootDir: TEST_DIR, podcastPath });
  return { store, publish: (writingFilename: string, title: string, markdown: string) => store.publish({ writingFilename, title, markdown }) };
}

describe("本地目录稿件存储:发布", () => {
  it("发布后当前文件出现在相对根下,内容逐字节一致,version = sha256(markdown)", async () => {
    const { publish } = makeStore();
    const markdown = "---\ntitle: 测试单集\n---\n\n# 测试单集\n\n正文。";
    const result = await publish("20260927_测试播客_第一集", "第一集", markdown);

    expect(result.version).toBe(sha256(markdown));
    expect(result.version).toMatch(/^[0-9a-f]{64}$/);
    expect(result.path).toBe("podcasts/transcripts/20260927_测试播客_第一集.md");

    const current = join(TEST_DIR, "podcasts/transcripts/20260927_测试播客_第一集.md");
    expect(existsSync(current)).toBe(true);
    expect(readFileSync(current, "utf-8")).toBe(markdown);
  });

  it("本地发布的相对路径与 GitHub 实现的 podcastPaths 同构", async () => {
    const { publish } = makeStore("podcasts/transcripts");
    const result = await publish("20260927_测试播客_第一集", "第一集", "# 正文");
    const github = podcastPaths(
      { GITHUB_PODCAST_PATH: "podcasts/transcripts" } as unknown as Env,
      "20260927_测试播客_第一集",
      "第一集",
    );
    expect(result.path).toBe(github.finalPath);
  });

  it("writingFilename 缺失时回退安全命名(fallbackStem),与 GitHub 版一致", async () => {
    const { publish } = makeStore();
    const result = await publish("", "我的单集", "# 正文");
    expect(result.path).toMatch(/^podcasts\/transcripts\/\d{8}_我的单集\.md$/);
  });

  it("发布是幂等的:同内容两次发布得到同一 version,快照仅一份", async () => {
    const { publish } = makeStore();
    const markdown = "# 同内容\n\n正文。";
    const first = await publish("20260927_测试播客_幂等", "幂等", markdown);
    const second = await publish("20260927_测试播客_幂等", "幂等", markdown);

    expect(second.version).toBe(first.version);
    const snapshotDir = join(TEST_DIR, ".versions/podcasts/transcripts/20260927_测试播客_幂等");
    expect(readdirSync(snapshotDir)).toEqual([`${first.version}.md`]);
    expect(readFileSync(join(TEST_DIR, "podcasts/transcripts/20260927_测试播客_幂等.md"), "utf-8")).toBe(markdown);
  });
});

describe("本地目录稿件存储:版本化与发布快照读取", () => {
  it("覆盖不同内容保留全部历史:read(path) 最新,read(path, v1/v2) 各读各的快照", async () => {
    const { publish, store } = makeStore();
    const v1 = await publish("20260927_测试播客_历史", "历史", "# 第一版");
    const v2 = await publish("20260927_测试播客_历史", "历史", "# 第二版");

    expect(v1.version).not.toBe(v2.version);
    expect(await store.read(v2.path)).toBe("# 第二版");
    expect(await store.read(v2.path, v1.version)).toBe("# 第一版");
    expect(await store.read(v2.path, v2.version)).toBe("# 第二版");

    const snapshotDir = join(TEST_DIR, ".versions/podcasts/transcripts/20260927_测试播客_历史");
    expect(readdirSync(snapshotDir).map(name => name.replace(/\.md$/, "")).sort()).toEqual([v1.version, v2.version].sort());
  });

  it("read 不存在的 path / 非法或不存在的 version → null,不抛错", async () => {
    const { publish, store } = makeStore();
    const saved = await publish("20260927_测试播客_缺失", "缺失", "# 正文");

    expect(await store.read("podcasts/transcripts/不存在.md")).toBeNull();
    expect(await store.read(saved.path, "f".repeat(64))).toBeNull();
    // 40 位 hex(GitHub commit sha 长度)同样被 VERSION_PATTERN 接受后按缺失处理
    expect(await store.read(saved.path, "a".repeat(40))).toBeNull();
    // 穿越/非法串按缺失处理
    expect(await store.read(saved.path, "../../etc/passwd")).toBeNull();
  });

  it("自愈:快照丢失但当前文件哈希恰为该版本时仍可按版本读取", async () => {
    const { publish, store } = makeStore();
    const saved = await publish("20260927_测试播客_自愈", "自愈", "# 唯一版本");
    rmSync(join(TEST_DIR, ".versions"), { recursive: true, force: true });
    expect(await store.read(saved.path, saved.version)).toBe("# 唯一版本");
    // 哈希不符(内容已变)→ null
    await store.publish({ writingFilename: "20260927_测试播客_自愈", title: "自愈", markdown: "# 新内容" });
    expect(await store.read(saved.path, saved.version)).toBeNull();
  });
});

describe("本地目录稿件存储:路径安全", () => {
  it("writingFilename 中的穿越与分隔符被收敛为单分量,落盘不越出 root", async () => {
    const { publish } = makeStore();
    const result = await publish("../../secrets/leak", "穿越", "# 正文");

    // 与 GitHub 版 safeStem 行为逐字节一致:分隔符变 _,开头点号剥去 → 文件名不以点开头,
    // `..` 残留在单分量文件名内不构成路径穿越(resolve 后仍在 root 内)。
    const github = podcastPaths({ GITHUB_PODCAST_PATH: "podcasts/transcripts" } as unknown as Env, "../../secrets/leak", "穿越");
    expect(result.path).toBe(github.finalPath);
    expect(result.path.split("/").pop()).toBe("_.._secrets_leak.md");
    // 落盘位置在 root 内的预期路径,没有任何越界目录被创建
    expect(existsSync(join(TEST_DIR, "podcasts/transcripts/_.._secrets_leak.md"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "secrets"))).toBe(false);
  });

  it("read 传入穿越 path 抛错,绝不读写 root 之外", async () => {
    const { store } = makeStore();
    await expect(store.read("../outside.md")).rejects.toThrow(/traversal/);
    await expect(store.read("podcasts/../../outside.md")).rejects.toThrow(/traversal/);
    await expect(store.read("podcasts/transcripts/../../../outside.md")).rejects.toThrow(/traversal/);
  });

  it("stem 永不以点开头(不会与 .versions 冲突),分隔符收敛为单分量", async () => {
    const { publish } = makeStore();
    const hidden = await publish(".hidden", "x", "# 正文");
    expect(hidden.path).toBe("podcasts/transcripts/hidden.md");
    expect(existsSync(join(TEST_DIR, "podcasts/transcripts/hidden.md"))).toBe(true);

    const slash = await publish("a/b", "x", "# 正文");
    expect(slash.path).toBe("podcasts/transcripts/a_b.md");
    expect(existsSync(join(TEST_DIR, "podcasts/transcripts/a_b.md"))).toBe(true);
  });
});

describe("本地目录稿件存储:list()", () => {
  it("列出相对根下的当前 .md(path + 当前 version = 内容哈希),不含 .versions,按 path 排序", async () => {
    const { publish, store } = makeStore();
    const a = await publish("20260927_测试播客_A", "A", "# A");
    const b = await publish("20260927_测试播客_B", "B", "# B");
    // 覆盖 A,当前 version 应更新,历史只在 .versions
    const a2 = await publish("20260927_测试播客_A", "A", "# A2");

    const listed = await store.list();
    expect(listed.map(entry => entry.path)).toEqual([
      "podcasts/transcripts/20260927_测试播客_A.md",
      "podcasts/transcripts/20260927_测试播客_B.md",
    ]);
    expect(listed[0]).toEqual({ path: a2.path, version: a2.version });
    expect(listed[0].version).not.toBe(a.version);
    expect(listed[1].version).toBe(b.version);
  });

  it("相对根不存在时返回空列表", async () => {
    const { store } = makeStore();
    expect(await store.list()).toEqual([]);
  });
});

describe("本地目录稿件存储:MANUSCRIPT_PATH 语义", () => {
  it("rootDir 由调用方决定(挂载卷路径),相对根可定制", async () => {
    const customRoot = join(TEST_DIR, "custom-root");
    const store = createLocalManuscriptStore({ rootDir: customRoot, podcastPath: "custom/podcasts" });
    const result = await store.publish({ writingFilename: "20260927_x", title: "x", markdown: "# 正文" });
    expect(result.path).toBe("custom/podcasts/20260927_x.md");
    expect(existsSync(join(customRoot, "custom/podcasts/20260927_x.md"))).toBe(true);
  });

  it("外部预置文件同样可被读取(用户手工放入的 Markdown)", async () => {
    const { store } = makeStore();
    mkdirSync(join(TEST_DIR, "podcasts/transcripts"), { recursive: true });
    writeFileSync(join(TEST_DIR, "podcasts/transcripts/手工放置.md"), "# 手工", "utf-8");
    expect(await store.read("podcasts/transcripts/手工放置.md")).toBe("# 手工");
  });
});
