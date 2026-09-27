/**
 * 本地 Node 运行时环境装配工厂：整合 SQLite、本地卷存储、进程内工作流引擎和静态资源服务。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../../types";
import { runProcessingPipeline } from "../../workflows/pipeline";
import { createLocalAssetFetcher, type LocalAssetFetcher } from "./assets";
import { applyLocalMigrations, createSqliteDatabase } from "./sqlite";
import { createLocalObjectStore, resolveOrGenerateSigningSecret } from "./storage";
import { createLocalWorkflowEngine } from "./workflow";
import type { ObjectStore, TaskWorkflowEngine } from "../types";

export interface NodeEnvOptions {
  databasePath?: string;
  storageDir?: string;
  publicDir?: string;
  migrationsDir?: string;
  baseUrl?: string | (() => string);
  signingSecret?: string;
  dataDir?: string;
  env?: Record<string, string | undefined>;
}

export interface NodePlatformRuntime {
  env: Env;
  dbSync: DatabaseSync;
  workflowEngine: TaskWorkflowEngine & {
    resumeRunningWorkflows: () => Promise<number>;
    waitForInstance: (id: string, timeoutMs?: number) => Promise<string>;
  };
  objectStore: ObjectStore;
  assets: LocalAssetFetcher;
  signingSecret: string;
  close: () => void;
}

export function createNodeEnv(options: NodeEnvOptions = {}): NodePlatformRuntime {
  const rawEnv = options.env ?? process.env;

  const dbPath = options.databasePath || rawEnv.DATABASE_PATH || "./data/read-podcast.db";
  const dataDir = options.dataDir || (dbPath !== ":memory:" ? dirname(resolve(dbPath)) : "./data");
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  const dbSync = new DatabaseSync(dbPath);

  const migrationsDir = options.migrationsDir || resolve(process.cwd(), "migrations");
  applyLocalMigrations(dbSync, migrationsDir);

  const storageDir = options.storageDir || rawEnv.STORAGE_PATH || "./data/storage";
  const envBaseUrl = rawEnv.APP_BASE_URL || (rawEnv.BASE_URL && rawEnv.BASE_URL.startsWith("http") ? rawEnv.BASE_URL : undefined);
  const baseUrl = options.baseUrl || envBaseUrl || "http://127.0.0.1:3000";
  const signingSecret = resolveOrGenerateSigningSecret({
    explicitSecret: options.signingSecret || rawEnv.INTERNAL_SIGNING_SECRET,
    dataDir,
  });
  const objectStore = createLocalObjectStore({
    rootDir: storageDir,
    baseUrl,
    signingSecret,
    dataDir,
  });

  const publicDir = options.publicDir || rawEnv.PUBLIC_PATH || "./public";
  const assets = createLocalAssetFetcher(publicDir);

  const db = createSqliteDatabase(dbSync);

  let platformEnv: Env;

  const workflowEngine = createLocalWorkflowEngine({
    db: dbSync,
    handler: async (params, instanceId, step) => {
      return runProcessingPipeline(platformEnv, params, instanceId, step);
    },
  });

  platformEnv = {
    db,
    storage: objectStore,
    workflows: workflowEngine,
    assets,
    APP_ENV: rawEnv.APP_ENV || "production",
    TRANSCRIPTION_SERVICE_URL: rawEnv.TRANSCRIPTION_SERVICE_URL || "http://127.0.0.1:28100",
    TRANSCRIPTION_PROVIDER: rawEnv.TRANSCRIPTION_PROVIDER || "self-hosted",
    TRANSCRIPTION_LANGUAGE: rawEnv.TRANSCRIPTION_LANGUAGE || "",
    REFINER_API_KEY: rawEnv.REFINER_API_KEY || "",
    GITHUB_TOKEN: rawEnv.GITHUB_TOKEN || "",
    GITHUB_OWNER: rawEnv.GITHUB_OWNER || "",
    GITHUB_REPO: rawEnv.GITHUB_REPO || "",
    GITHUB_BRANCH: rawEnv.GITHUB_BRANCH || "main",
    GITHUB_PODCAST_PATH: rawEnv.GITHUB_PODCAST_PATH || "podcasts/transcripts",
    MANUSCRIPT_TIME_ZONE: rawEnv.MANUSCRIPT_TIME_ZONE || "Asia/Shanghai",
    GITHUB_API_BASE: rawEnv.GITHUB_API_BASE,
    DASHSCOPE_API_KEY: rawEnv.DASHSCOPE_API_KEY,
    CF_ACCESS_CLIENT_ID: rawEnv.CF_ACCESS_CLIENT_ID,
    CF_ACCESS_CLIENT_SECRET: rawEnv.CF_ACCESS_CLIENT_SECRET,
    TRUSTED_INTERNAL_TRANSCRIPTION: rawEnv.TRUSTED_INTERNAL_TRANSCRIPTION ?? "true",
  } as unknown as Env;

  return {
    env: platformEnv,
    dbSync,
    workflowEngine,
    objectStore,
    assets,
    signingSecret,
    close: () => {
      try {
        dbSync.close();
      } catch {}
    },
  };
}
