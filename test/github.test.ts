import { afterEach, describe, expect, it, vi } from "vitest";
import { podcastPaths, readPodcastContent } from "../src/github";
import type { Env } from "../src/types";

describe("podcastPaths", () => {
  it("places the final note under the configured root using build_filename_base", () => {
    const env = { GITHUB_PODCAST_PATH: "podcasts/transcripts" } as Env;
    // build_filename_base 产物保留 Unicode 文件名。
    const paths = podcastPaths(env, "20260519_忽左忽右_474_孙立天谈康熙废储（精修）");
    expect(paths.finalPath).toBe(
      "podcasts/transcripts/20260519_忽左忽右_474_孙立天谈康熙废储（精修）.md",
    );
    // 不再产出原始转录路径（原始转录不入 GitHub）。
    expect((paths as { rawPath?: string }).rawPath).toBeUndefined();
  });

  it("normalizes a trailing slash on the configured root", () => {
    const env = { GITHUB_PODCAST_PATH: "podcasts/transcripts/" } as Env;
    const paths = podcastPaths(env, "20260519_忽左忽右_474");
    expect(paths.finalPath).toBe("podcasts/transcripts/20260519_忽左忽右_474.md");
  });

  it("rejects path traversal in the filename", () => {
    const env = { GITHUB_PODCAST_PATH: "podcasts/transcripts" } as Env;
    const paths = podcastPaths(env, "../../secrets/leak");
    // 收敛成单个安全分量：目录仍是配置根，文件名不含穿越序列。
    // 关键安全属性：文件名收敛成单个分量（无路径分隔符、不以点开头），
    // 无法越出配置目录。分量内部残留的点号是普通字符，不构成穿越。
    const stem = paths.finalPath.slice("podcasts/transcripts/".length, -".md".length);
    expect(stem.includes("/")).toBe(false);
    expect(stem.includes("\\")).toBe(false);
    expect(stem.startsWith(".")).toBe(false);
  });

  it("falls back to a safe dated name when no filename is supplied", () => {
    const env = { GITHUB_PODCAST_PATH: "podcasts/transcripts" } as Env;
    const paths = podcastPaths(env, "", "一次 / 有问题的访谈", new Date("2026-09-18T00:00:00Z"));
    expect(paths.finalPath.startsWith("podcasts/transcripts/20260918_")).toBe(true);
    const stem = paths.finalPath.slice("podcasts/transcripts/".length, -".md".length);
    expect(stem.includes("/")).toBe(false);
  });
});

describe("Store repository configuration", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("fails clearly instead of requesting /repos// when GITHUB_OWNER / GITHUB_REPO are not deployed", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const env = { GITHUB_TOKEN: "t", GITHUB_OWNER: "", GITHUB_REPO: "", GITHUB_BRANCH: "main" } as unknown as Env;
    await expect(readPodcastContent(env, "podcasts/transcripts/a.md")).rejects.toThrow("GITHUB_OWNER / GITHUB_REPO are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
