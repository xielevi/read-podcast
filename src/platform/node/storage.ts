/**
 * 本地卷对象存储适配器：基于本地文件系统实现 ObjectStore 接口。
 * 支持分片上传、临时 HMAC 签名下载地址以及对象生命周期自动保留清理（uploads 1天，raw/refined 7天）。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  MultipartUpload,
  ObjectListing,
  ObjectMetadata,
  ObjectStore,
  StoredObject,
} from "../types";

export interface LocalStorageOptions {
  rootDir: string;
  baseUrl?: string | (() => string);
  signingSecret?: string;
}

function resolveKeyPath(rootDir: string, key: string): string {
  const normalizedKey = key.replace(/^\/+/, "");
  const resolved = resolve(rootDir, normalizedKey);
  const resolvedRoot = resolve(rootDir);
  if (!resolved.startsWith(resolvedRoot + sep) && resolved !== resolvedRoot) {
    throw new Error(`Invalid object key traversal: ${key}`);
  }
  return resolved;
}

function walkFiles(dir: string, baseDir: string, out: Array<{ key: string; size: number; uploaded: Date }> = []): Array<{ key: string; size: number; uploaded: Date }> {
  if (!existsSync(dir)) return out;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".multiparts") continue;
      walkFiles(fullPath, baseDir, out);
    } else if (entry.isFile()) {
      const stat = statSync(fullPath);
      const key = relative(baseDir, fullPath).split(sep).join("/");
      out.push({ key, size: stat.size, uploaded: stat.mtime });
    }
  }
  return out;
}

export function verifyStorageSignature(
  key: string,
  expires: number,
  signature: string,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (Math.floor(nowMs / 1000) > expires) return false;
  const expected = createHmac("sha256", secret).update(`${key}:${expires}`).digest("hex");
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function createLocalObjectStore(storeOptions: LocalStorageOptions): ObjectStore {
  const rootDir = resolve(storeOptions.rootDir);
  mkdirSync(rootDir, { recursive: true });
  const signingSecret = storeOptions.signingSecret || "read-podcast-local-storage-secret";
  const getBaseUrl = () => {
    let raw = typeof storeOptions.baseUrl === "function" ? storeOptions.baseUrl() : (storeOptions.baseUrl || "http://127.0.0.1:3000");
    if (!raw || !raw.startsWith("http")) raw = "http://127.0.0.1:3000";
    return raw.replace(/\/+$/, "");
  };

  const multipartDir = join(rootDir, ".multiparts");
  mkdirSync(multipartDir, { recursive: true });

  const getMultipartAdapter = (key: string, uploadId: string): MultipartUpload => {
    const partDir = join(multipartDir, uploadId);
    return {
      uploadId,
      key,
      uploadPart: async (partNumber: number, value: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer) => {
        mkdirSync(partDir, { recursive: true });
        const partFile = join(partDir, `${partNumber}`);
        if (value instanceof ReadableStream) {
          const writeStream = createWriteStream(partFile);
          await pipeline(Readable.fromWeb(value as any), writeStream);
        } else if (value instanceof Uint8Array) {
          writeFileSync(partFile, Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        } else {
          writeFileSync(partFile, Buffer.from(value));
        }
        return { partNumber, etag: `part-${uploadId}-${partNumber}` };
      },
      complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
        const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        const targetPath = resolveKeyPath(rootDir, key);
        mkdirSync(dirname(targetPath), { recursive: true });

        const targetStream = createWriteStream(targetPath);
        for (const p of sorted) {
          const partPath = join(partDir, `${p.partNumber}`);
          if (!existsSync(partPath)) {
            targetStream.close();
            throw new Error(`Part ${p.partNumber} not found during completion`);
          }
          await pipeline(createReadStream(partPath), targetStream, { end: false });
        }
        targetStream.end();

        await new Promise((res, rej) => {
          targetStream.on("finish", () => res(undefined));
          targetStream.on("error", rej);
        });

        rmSync(partDir, { recursive: true, force: true });
        const finalStat = statSync(targetPath);
        return { key, size: finalStat.size };
      },
      abort: async () => {
        rmSync(partDir, { recursive: true, force: true });
      },
    };
  };

  return {
    async get(key: string): Promise<StoredObject | null> {
      const fullPath = resolveKeyPath(rootDir, key);
      if (!existsSync(fullPath)) return null;
      const stat = statSync(fullPath);
      return {
        key,
        size: stat.size,
        text: async () => readFile(fullPath, "utf-8"),
        body: Readable.toWeb(createReadStream(fullPath)) as ReadableStream<Uint8Array>,
      };
    },

    async put(
      key: string,
      value: string | ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
    ): Promise<{ key: string; size: number }> {
      const fullPath = resolveKeyPath(rootDir, key);
      mkdirSync(dirname(fullPath), { recursive: true });

      if (value instanceof ReadableStream) {
        const writeStream = createWriteStream(fullPath);
        await pipeline(Readable.fromWeb(value as any), writeStream);
        const stat = statSync(fullPath);
        return { key, size: stat.size };
      }

      if (value instanceof Uint8Array) {
        writeFileSync(fullPath, Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      } else if (value instanceof ArrayBuffer) {
        writeFileSync(fullPath, Buffer.from(value));
      } else {
        writeFileSync(fullPath, value, "utf-8");
      }

      const stat = statSync(fullPath);
      return { key, size: stat.size };
    },

    async delete(key: string | string[]): Promise<void> {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) {
        const fullPath = resolveKeyPath(rootDir, k);
        if (existsSync(fullPath)) {
          unlinkSync(fullPath);
        }
      }
    },

    async head(key: string): Promise<ObjectMetadata | null> {
      const fullPath = resolveKeyPath(rootDir, key);
      if (!existsSync(fullPath)) return null;
      const stat = statSync(fullPath);
      return {
        key,
        size: stat.size,
        uploaded: stat.mtime,
        httpEtag: `"${stat.mtimeMs}-${stat.size}"`,
      };
    },

    async list(options?: { prefix?: string; limit?: number }): Promise<ObjectListing> {
      const prefix = options?.prefix ?? "";
      const limit = options?.limit ?? 1000;
      const all = walkFiles(rootDir, rootDir)
        .filter(item => item.key.startsWith(prefix))
        .sort((a, b) => a.key.localeCompare(b.key));
      const sliced = all.slice(0, limit);
      return {
        objects: sliced,
        truncated: all.length > limit,
      };
    },

    async createMultipartUpload(key: string): Promise<MultipartUpload> {
      const uploadId = `localmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return getMultipartAdapter(key, uploadId);
    },

    resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
      return getMultipartAdapter(key, uploadId);
    },

    async createPresignedUrl(key: string, options?: { nowMs?: number; expiresInSeconds?: number }): Promise<string> {
      const nowMs = options?.nowMs ?? Date.now();
      const ttl = options?.expiresInSeconds ?? 7200;
      const expires = Math.floor(nowMs / 1000) + ttl;
      const sig = createHmac("sha256", signingSecret).update(`${key}:${expires}`).digest("hex");
      return `${getBaseUrl()}/storage/download?key=${encodeURIComponent(key)}&expires=${expires}&sig=${sig}`;
    },
  };
}

export async function cleanExpiredObjects(rootDir: string, nowMs = Date.now()): Promise<{ deletedFiles: number }> {
  let deletedFiles = 0;
  const policies = [
    { prefix: "uploads", maxAgeMs: 1 * 86_400_000 },
    { prefix: "raw", maxAgeMs: 7 * 86_400_000 },
    { prefix: "refined", maxAgeMs: 7 * 86_400_000 },
  ];

  for (const { prefix, maxAgeMs } of policies) {
    const targetDir = join(rootDir, prefix);
    if (!existsSync(targetDir)) continue;
    const files = walkFiles(targetDir, rootDir);
    for (const file of files) {
      if (nowMs - file.uploaded.getTime() > maxAgeMs) {
        const fullPath = join(rootDir, file.key);
        if (existsSync(fullPath)) {
          unlinkSync(fullPath);
          deletedFiles += 1;
        }
      }
    }
  }

  // 清理超期未完成的 multipart 目录（超过 1 天）
  const multipartDir = join(rootDir, ".multiparts");
  if (existsSync(multipartDir)) {
    const entries = readdirSync(multipartDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullDir = join(multipartDir, entry.name);
        const stat = statSync(fullDir);
        if (nowMs - stat.mtimeMs > 1 * 86_400_000) {
          await rm(fullDir, { recursive: true, force: true });
        }
      }
    }
  }

  return { deletedFiles };
}
