/**
 * 本地目录稿件存储适配器:基于本地文件系统实现 ManuscriptStore 接口
 * (Canonical Manuscript Store 的 Docker 实现,#28)。
 *
 * 目录布局(rootDir = MANUSCRIPT_PATH,如 /data/manuscripts):
 * - 当前文件:{rootDir}/{podcastPath}/{stem}.md —— 用户直接拿到、可放进 Obsidian;
 * - 版本快照:{rootDir}/.versions/{podcastPath}/{stem}/{version}.md —— 内容寻址,
 *   version = sha256(content) hex(64 位),覆盖发布保留全部历史,永不自动清理
 *   (成稿是 durable 数据,不参与本地对象存储的 7 天保留策略)。
 *
 * 与 GitHub 实现(src/github.ts)共用命名规则与 front matter 格式,同一部署内
 * D1 content_path 在两种实现下同构;version 与 40 位 git commit sha 共存于
 * D1 commit_sha TEXT 列,语义都是「不可变的发布快照标识」。
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { manuscriptRelativePath } from "../../github";
import type { ManuscriptStore, ManuscriptVersion } from "../types";

export interface LocalManuscriptStoreOptions {
  /** 稿件存储根目录(MANUSCRIPT_PATH,挂载卷内)。 */
  rootDir: string;
  /** 稿件相对根;缺省 podcasts/transcripts(与 GITHUB_PODCAST_PATH 同源同默认)。 */
  podcastPath?: string;
}

/** 版本标识只允许 hex(GitHub commit sha 40 位 | 本地内容哈希 64 位);同时阻断经 version 参数的路径穿越。 */
const VERSION_PATTERN = /^[0-9a-f]{40,64}$/i;

/** 防目录穿越(语义同 storage.ts 的 resolveKeyPath):解析结果必须落在 rootDir 内。 */
function resolveUnderRoot(rootDir: string, relativePath: string): string {
  const normalized = relativePath.replace(/^\/+/, "");
  const resolved = resolve(rootDir, normalized);
  const resolvedRoot = resolve(rootDir);
  if (!resolved.startsWith(resolvedRoot + sep) && resolved !== resolvedRoot) {
    throw new Error(`Invalid manuscript path traversal: ${relativePath}`);
  }
  return resolved;
}

export function createLocalManuscriptStore(options: LocalManuscriptStoreOptions): ManuscriptStore {
  const rootDir = resolve(options.rootDir);
  const podcastPath = (options.podcastPath || "podcasts/transcripts").replace(/^\/+|\/+$/g, "");
  mkdirSync(rootDir, { recursive: true });

  const sha256HexSync = (content: string): string => createHash("sha256").update(content, "utf-8").digest("hex");

  /** 同目录临时文件 + rename 的原子写入:进程崩溃不留半截文件,Obsidian 同步不会读到半个文件。 */
  const writeAtomic = (target: string, content: string): void => {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.${basename(target)}.${Buffer.from(randomBytes(6)).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, content, "utf-8");
      renameSync(tmp, target);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    }
  };

  const versionSnapshotPath = (path: string, version: string): string =>
    resolveUnderRoot(rootDir, join(".versions", path.replace(/\.md$/, ""), `${version}.md`));

  return {
    async publish(input): Promise<ManuscriptVersion> {
      const { finalPath } = manuscriptRelativePath(podcastPath, input.writingFilename, input.title);
      const version = sha256HexSync(input.markdown);
      const currentFile = resolveUnderRoot(rootDir, finalPath);
      const snapshotFile = versionSnapshotPath(finalPath, version);
      // 快照先行(内容寻址:存在即同内容,跳过);当前文件总是原子覆写——
      // 重放、以及「快照已写但当前文件未写」的崩溃中间态都能收敛到正确终态。
      if (!existsSync(snapshotFile)) writeAtomic(snapshotFile, input.markdown);
      writeAtomic(currentFile, input.markdown);
      return { path: finalPath, version };
    },

    async read(path: string, version?: string): Promise<string | null> {
      const currentFile = resolveUnderRoot(rootDir, path);
      if (version === undefined || version === "") {
        return existsSync(currentFile) ? readFileSync(currentFile, "utf-8") : null;
      }
      if (!VERSION_PATTERN.test(version)) return null; // 非法版本(含穿越串)按缺失处理,不抛错
      const snapshotFile = versionSnapshotPath(path, version);
      // 版本快照优先;快照缺失时自愈——校验当前文件内容哈希是否恰为该版本
      // (覆盖快照丢失 / 只人工保留过单文件的部署),哈希不符才返回 null。
      if (existsSync(snapshotFile)) return readFileSync(snapshotFile, "utf-8");
      if (existsSync(currentFile)) {
        const current = readFileSync(currentFile, "utf-8");
        if (sha256HexSync(current) === version.toLowerCase()) return current;
      }
      return null;
    },

    async list(): Promise<Array<{ path: string; version: string }>> {
      const base = join(rootDir, podcastPath);
      if (!existsSync(base)) return [];
      const out: Array<{ path: string; version: string }> = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && entry.name.endsWith(".md")) {
            const path = relative(rootDir, full).split(sep).join("/");
            out.push({ path, version: sha256HexSync(readFileSync(full, "utf-8")) });
          }
        }
      };
      walk(base); // .versions 在相对根之外(rootDir 直下),天然不会被列出
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}
