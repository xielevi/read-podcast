/**
 * 本地 Node 运行时环境装配工厂：整合 SQLite、本地卷存储、进程内工作流引擎和静态资源服务。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGitHubManuscriptStore, githubManuscriptConfigured } from "../../github";
import { resolveManuscriptBackend, withLegacyGitHubReads } from "../../manuscript_backend";
import { createNotionR2ManuscriptStore, isManuscriptObjectKey, isNotionPageId } from "../../notion_manuscript";
import type { Env } from "../../types";
import { runProcessingPipeline } from "../../workflows/pipeline";
import { createLocalAssetFetcher, type LocalAssetFetcher } from "./assets";
import { createLocalManuscriptStore } from "./manuscript";
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
  /** 稿件存储本地目录(MANUSCRIPT_PATH);配置后优先于 GitHub 回落(测试可注入临时目录)。 */
  manuscriptDir?: string;
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
    CONTROL_AUTH_MODE: "local",
    TRANSCRIPTION_LANGUAGE: rawEnv.TRANSCRIPTION_LANGUAGE || "",
    REFINER_API_KEY: rawEnv.REFINER_API_KEY || "",
    GITHUB_TOKEN: rawEnv.GITHUB_TOKEN || "",
    GITHUB_OWNER: rawEnv.GITHUB_OWNER || "",
    GITHUB_REPO: rawEnv.GITHUB_REPO || "",
    GITHUB_BRANCH: rawEnv.GITHUB_BRANCH || "main",
    GITHUB_PODCAST_PATH: rawEnv.GITHUB_PODCAST_PATH || "podcasts/transcripts",
    MANUSCRIPT_TIME_ZONE: rawEnv.MANUSCRIPT_TIME_ZONE || "Asia/Shanghai",
    GITHUB_API_BASE: rawEnv.GITHUB_API_BASE,
    MANUSCRIPT_STORE: rawEnv.MANUSCRIPT_STORE,
    NOTION_TOKEN: rawEnv.NOTION_TOKEN,
    NOTION_MANUSCRIPT_STORE: rawEnv.NOTION_MANUSCRIPT_STORE,
    NOTION_PODCAST_DATA_SOURCE_ID: rawEnv.NOTION_PODCAST_DATA_SOURCE_ID,
    NOTION_PODCAST_DATABASE_ID: rawEnv.NOTION_PODCAST_DATABASE_ID,
    NOTION_API_BASE: rawEnv.NOTION_API_BASE,
    NOTION_SCHEMA: rawEnv.NOTION_SCHEMA,
    NOTION_SCHEMA_JSON: rawEnv.NOTION_SCHEMA_JSON,
    NOTION_PROPERTY_MAP: rawEnv.NOTION_PROPERTY_MAP,
    NOTION_SHOW_OPTIONS: rawEnv.NOTION_SHOW_OPTIONS,
    NOTION_SHOW_OTHER: rawEnv.NOTION_SHOW_OTHER,
    NOTION_STATUS_VALUES: rawEnv.NOTION_STATUS_VALUES,
    NOTION_TRANSCRIPT_VALUES: rawEnv.NOTION_TRANSCRIPT_VALUES,
    MANUSCRIPT_PUBLIC_ORIGIN: rawEnv.MANUSCRIPT_PUBLIC_ORIGIN,
    DASHSCOPE_API_KEY: rawEnv.DASHSCOPE_API_KEY,
    CF_ACCESS_CLIENT_ID: rawEnv.CF_ACCESS_CLIENT_ID,
    CF_ACCESS_CLIENT_SECRET: rawEnv.CF_ACCESS_CLIENT_SECRET,
    CONTROL_AUTH_USER: rawEnv.CONTROL_AUTH_USER,
    CONTROL_AUTH_PASSWORD: rawEnv.CONTROL_AUTH_PASSWORD,
    TRUSTED_INTERNAL_TRANSCRIPTION: rawEnv.TRUSTED_INTERNAL_TRANSCRIPTION ?? "true",
  } as unknown as Env;

  const manuscriptDir = options.manuscriptDir || rawEnv.MANUSCRIPT_PATH || "";
  const backend = resolveManuscriptBackend(rawEnv, { platform: "node", localDir: manuscriptDir });
  if (backend === "local") {
    if (!manuscriptDir) {
      console.warn("MANUSCRIPT_STORE=local requires MANUSCRIPT_PATH. Publishing will fail until it is set.");
    }
    platformEnv.manuscripts = createLocalManuscriptStore({
      rootDir: manuscriptDir || "./manuscripts",
      podcastPath: rawEnv.GITHUB_PODCAST_PATH,
    });
  } else if (backend === "notion-r2") {
    const notion = createNotionR2ManuscriptStore(platformEnv);
    platformEnv.manuscripts = githubManuscriptConfigured(platformEnv)
      ? withLegacyGitHubReads(notion, createGitHubManuscriptStore(platformEnv), isManuscriptObjectKey, isNotionPageId)
      : notion;
  } else {
    if (!githubManuscriptConfigured(platformEnv)) {
      console.warn(
        "No manuscript store configured: set MANUSCRIPT_PATH (local directory, default for Docker), "
        + "MANUSCRIPT_STORE=notion-r2 with a Notion token, "
        + "or GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO. "
        + "Publishing will fail until one is set.",
      );
    }
    platformEnv.manuscripts = createGitHubManuscriptStore(platformEnv);
  }

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
