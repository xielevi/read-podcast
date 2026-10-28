import type { ManuscriptStore } from "./platform/types";

/**
 * Canonical Manuscript Store 后端选择。只在平台装配层调用一次。
 *
 *   github     Cloudflare 默认；Docker 在未设本地目录时的回落
 *   local      Docker 默认（MANUSCRIPT_PATH）
 *   notion-r2  可选：Notion 可编辑页 + 对象存储里的不可变快照
 *
 * 显式 `MANUSCRIPT_STORE` 优先。`NOTION_MANUSCRIPT_STORE=true|false` 是兼容别名
 * （true → notion-r2，false → 该平台默认）。凭据齐全不会自动切到 Notion。
 */
export type ManuscriptBackend = "github" | "notion-r2" | "local";

export const MANUSCRIPT_BACKENDS: readonly ManuscriptBackend[] = ["github", "notion-r2", "local"];

export interface ManuscriptBackendEnv {
  MANUSCRIPT_STORE?: string;
  NOTION_MANUSCRIPT_STORE?: string;
  /** 凭据不是选择器：出现在此仅方便测试证明它们不会自动开启 Notion。 */
  NOTION_TOKEN?: string;
  NOTION_PODCAST_DATA_SOURCE_ID?: string;
}

function normalizeBackend(value: string | undefined): ManuscriptBackend | "" {
  const text = (value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (text === "github" || text === "gh") return "github";
  if (text === "notion-r2" || text === "notion" || text === "notionr2") return "notion-r2";
  if (text === "local" || text === "dir" || text === "directory") return "local";
  return "";
}

function aliasBackend(value: string | undefined): ManuscriptBackend | "" {
  const text = (value ?? "").trim().toLowerCase();
  if (text === "true" || text === "1" || text === "on" || text === "yes") return "notion-r2";
  if (text === "false" || text === "0" || text === "off" || text === "no") return "github";
  return normalizeBackend(text);
}

export function resolveManuscriptBackend(
  env: ManuscriptBackendEnv,
  options: { platform: "cloudflare" | "node"; localDir?: string } = { platform: "cloudflare" },
): ManuscriptBackend {
  const explicit = normalizeBackend(env.MANUSCRIPT_STORE);
  const aliased = aliasBackend(env.NOTION_MANUSCRIPT_STORE);
  const chosen = explicit || aliased;
  const fallback: ManuscriptBackend = options.platform === "node" && (options.localDir ?? "").trim()
    ? "local"
    : "github";

  if (!chosen) return fallback;
  if (chosen === "local" && options.platform === "cloudflare") {
    console.warn("MANUSCRIPT_STORE=local is not supported on Cloudflare; using github");
    return "github";
  }
  if (chosen === "github" && !explicit && aliased === "github" && fallback === "local") {
    // NOTION_MANUSCRIPT_STORE=false on Docker keeps the local default.
    return "local";
  }
  return chosen;
}

export function notionManuscriptStoreEnabled(env: ManuscriptBackendEnv): boolean {
  return resolveManuscriptBackend(env, { platform: "cloudflare" }) === "notion-r2";
}

const SHA256_VERSION = /^[0-9a-f]{64}$/i;

export function isSnapshotVersion(version: string | undefined): boolean {
  return Boolean(version && SHA256_VERSION.test(version));
}

/**
 * 新稿写入 `writer`（github / local / notion-r2）。sha256 快照、`manuscripts/` 对象键、
 * Notion 页 id 先读 `snapshots`（对象存储 + 仍在的 Notion token）。这样回切到 GitHub
 * 发布后端后，已经用 notion-r2 发布的公开页仍能按 commit_sha 读到快照。
 */
export function withSnapshotReads(
  writer: ManuscriptStore,
  snapshots: ManuscriptStore,
  isSnapshotPath: (path: string) => boolean,
  isPageId: (path: string) => boolean,
): ManuscriptStore {
  return {
    publish: input => writer.publish(input),
    list: () => writer.list(),
    async read(path, version) {
      if (isSnapshotVersion(version) || isSnapshotPath(path) || isPageId(path)) {
        const hit = await snapshots.read(path, version);
        if (hit !== null || isSnapshotPath(path) || isPageId(path)) return hit;
      }
      return writer.read(path, version);
    },
  };
}

/**
 * notion-r2 写新稿。sha256 快照只读主 store。仓库路径 / 40 位 commit 仍可读 GitHub。
 */
export function withLegacyGitHubReads(
  primary: ManuscriptStore,
  legacy: ManuscriptStore,
  isSnapshotPath: (path: string) => boolean,
  isPrimaryPath: (path: string) => boolean,
): ManuscriptStore {
  const snapshots = withSnapshotReads(primary, primary, isSnapshotPath, isPrimaryPath);
  return {
    publish: input => primary.publish(input),
    list: () => primary.list(),
    async read(path, version) {
      if (isSnapshotVersion(version) || isSnapshotPath(path) || isPrimaryPath(path)) {
        return snapshots.read(path, version);
      }
      const current = await primary.read(path, version);
      if (current !== null) return current;
      return legacy.read(path, version);
    },
  };
}
