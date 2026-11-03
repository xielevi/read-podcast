/**
 * scripts/setup.mjs：参数解析、"已存在就跳过"的判断，以及对 cf / wrangler 调用的编排。
 * 所有 CLI / 网络 / 文件访问都走注入的 fake，测试绝不触碰真实云资源或本地 .deploy.env。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type LifecycleRule = { name: string; prefix: string; expireDays: number; abortMultipartDays?: number };
type CliResult = { status: number; stdout: string; stderr: string };
type Deps = {
  argv?: string[];
  isInteractive?: boolean;
  deployEnvPath?: string;
  readConfig: () => string;
  readFile: (path: string) => string | Promise<string>;
  writeFile: (path: string, content: string) => void | Promise<void>;
  runCf: (args: string[], options?: { input?: string }) => CliResult | Promise<CliResult>;
  runWrangler: (args: string[], options?: { input?: string }) => CliResult | Promise<CliResult>;
  prompt: (query: string, defaultValue: string) => string | Promise<string>;
  promptHidden: (query: string) => string | Promise<string>;
  fetch: (url: string, init?: unknown) => { status: number; headers: { get(name: string): string | null } } | Promise<{ status: number; headers: { get(name: string): string | null } }>;
  log: (text: string) => void;
  error: (text: string) => void;
};

// scripts/setup.mjs 是纯 JS 模块，仓库没有 .d.mts 声明，运行时由 vitest 直接加载。
// @ts-expect-error 无类型声明
const setup = (await import("../scripts/setup.mjs")) as {
  STEP_ORDER: string[];
  LIFECYCLE_RULES: LifecycleRule[];
  SECRET_PROMPTS: { name: string; hint: string }[];
  parseSetupArgs(argv: string[]): { steps: string[]; help: boolean; smokeExplicit: boolean };
  parseJsonc(text: string): unknown;
  extractJson(text: string): unknown;
  resourcesFromConfig(config: unknown): { workerName: string; d1Binding: string; d1DatabaseName: string; r2BucketName: string };
  findDatabaseId(databases: unknown, name: string): string | null;
  parseLifecycleRules(text: string): { id: string }[] | null;
  missingLifecycleRules(existingIds: string[], rules?: LifecycleRule[]): LifecycleRule[];
  lifecycleRuleBody(rule: LifecycleRule): Record<string, unknown>;
  lifecycleUpdateArgs(bucket: string, existing: { id: string }[], missing: LifecycleRule[]): string[];
  deployEnvContent(values: Record<string, string>): string;
  smokeChecks(domain: string): { name: string; url: string; status: number; locationIncludes?: string }[];
  runSetup(deps: Deps): Promise<number>;
};

const SCRIPT = fileURLToPath(new URL("../scripts/setup.mjs", import.meta.url));
const wranglerJsonc = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf-8");
const deploymentDoc = readFileSync(fileURLToPath(new URL("../docs/DEPLOYMENT.md", import.meta.url)), "utf-8");

const VALID_ENV = {
  READ_PODCAST_DOMAIN: "podcast.mydomain.net",
  READ_PODCAST_TRANSCRIPTION_URL: "https://transcribe.mydomain.net",
  READ_PODCAST_GITHUB_OWNER: "someone",
  READ_PODCAST_GITHUB_REPO: "notes",
};

// `cf r2 buckets lifecycle get` 的真实输出形态（含 Cloudflare 默认规则）。
const DEFAULT_LIFECYCLE_RULE = { id: "Default Multipart Abort Rule", enabled: true, conditions: {} };
const lifecycleOutput = (...ids: string[]) => JSON.stringify({ rules: [DEFAULT_LIFECYCLE_RULE, ...ids.map(id => ({ id, enabled: true }))] });
const FULL_LIFECYCLE = lifecycleOutput("raw-7d", "refined-7d", "uploads-1d");
const DATABASE_ID = "11111111-2222-4333-8444-555555555555";

/** 按 args 前缀分发的 fake CLI：记录全部调用，绝不真正 spawn。 */
function fakeCli(handlers: [string, (args: string[]) => CliResult][], calls: { args: string[]; input?: string }[]) {
  return async (args: string[], options: { input?: string } = {}) => {
    calls.push({ args, input: options.input });
    for (const [prefix, handle] of handlers) {
      if (args.join(" ").startsWith(prefix)) return handle(args);
    }
    throw new Error(`fake cli: unexpected command \`${args.join(" ")}\``);
  };
}

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    argv: [],
    isInteractive: false,
    deployEnvPath: "/nonexistent/.deploy.env",
    readConfig: () => wranglerJsonc,
    readFile: () => {
      throw new Error("ENOENT");
    },
    writeFile: () => {},
    runCf: async () => ({ status: 0, stdout: "", stderr: "" }),
    runWrangler: async () => ({ status: 0, stdout: "", stderr: "" }),
    prompt: (_query, defaultValue) => defaultValue,
    promptHidden: async () => "",
    fetch: (() => {
      throw new Error("no network in tests");
    }) as Deps["fetch"],
    log: () => {},
    error: () => {},
    ...overrides,
  };
}

describe("parseSetupArgs", () => {
  it("默认按规范顺序执行全部步骤", () => {
    expect(setup.parseSetupArgs([]).steps).toEqual(["login", "d1", "r2", "secrets", "env", "checklist", "smoke"]);
    expect(setup.parseSetupArgs([]).smokeExplicit).toBe(false);
  });

  it("--step 过滤并重新排序，可重复传入", () => {
    expect(setup.parseSetupArgs(["--step", "r2", "--step", "d1"]).steps).toEqual(["d1", "r2"]);
    expect(setup.parseSetupArgs(["--step=r2"]).steps).toEqual(["r2"]);
  });

  it("--smoke 单独使用时只跑冒烟并视为显式；与 --step 同用则追加", () => {
    const alone = setup.parseSetupArgs(["--smoke"]);
    expect(alone.steps).toEqual(["smoke"]);
    expect(alone.smokeExplicit).toBe(true);
    const appended = setup.parseSetupArgs(["--step", "env", "--smoke"]);
    expect(appended.steps).toEqual(["env", "smoke"]);
    expect(appended.smokeExplicit).toBe(true);
    expect(setup.parseSetupArgs(["--step", "smoke"]).smokeExplicit).toBe(true);
  });

  it("未知参数、未知步骤、缺值的 --step 都抛错", () => {
    expect(() => setup.parseSetupArgs(["--wat"])).toThrow("Unknown argument: --wat");
    expect(() => setup.parseSetupArgs(["--step", "bogus"])).toThrow("Unknown step: bogus");
    expect(() => setup.parseSetupArgs(["--step"])).toThrow("--step requires a step name");
  });

  it("--help 打印用法并直接退出", async () => {
    expect(setup.parseSetupArgs(["--help"]).help).toBe(true);
    const result = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });
});

describe("wrangler.jsonc 与配置解析", () => {
  it("从真实 wrangler.jsonc 取资源名", () => {
    const resources = setup.resourcesFromConfig(setup.parseJsonc(wranglerJsonc));
    expect(resources).toEqual({
      workerName: "read-podcast-edge",
      d1Binding: "DB",
      d1DatabaseName: "read-podcast-edge",
      r2BucketName: "read-podcast-edge-raw",
    });
  });

  it("JSONC 剥离注释但保留字符串里的 //", () => {
    expect(setup.parseJsonc('{ "a": "https://x.dev", /* 块注释 */ "b": [1] }')).toEqual({ a: "https://x.dev", b: [1] });
    expect(setup.parseJsonc('{ // 行注释\n "c": "//not-a-comment" }')).toEqual({ c: "//not-a-comment" });
  });

  it("extractJson 容忍 JSON 前的警告输出，无 JSON 时返回 null", () => {
    expect(setup.extractJson('{"loggedIn":true}')).toEqual({ loggedIn: true });
    expect(setup.extractJson("⚠️ some warning\n[1,2]")).toEqual([1, 2]);
    expect(setup.extractJson("")).toBe(null);
    expect(setup.extractJson("no json here")).toBe(null);
  });

  it("缺 database_name / bucket_name 时抛错", () => {
    expect(() => setup.resourcesFromConfig({ d1_databases: [{}], r2_buckets: [{ bucket_name: "b" }] })).toThrow("database_name");
    expect(() => setup.resourcesFromConfig({ d1_databases: [{ database_name: "d" }] })).toThrow("bucket_name");
  });
});

describe("生命周期规则", () => {
  it("docs/DEPLOYMENT.md 的规则表与 LIFECYCLE_RULES 一致", () => {
    for (const rule of setup.LIFECYCLE_RULES) {
      expect(deploymentDoc).toContain(`| \`${rule.name}\` | \`${rule.prefix}\` |`);
    }
  });

  it("missingLifecycleRules 只返回缺失项", () => {
    expect(setup.missingLifecycleRules([])).toHaveLength(3);
    expect(setup.missingLifecycleRules(["raw-7d"]).map(rule => rule.name)).toEqual(["refined-7d", "uploads-1d"]);
    expect(setup.missingLifecycleRules(["raw-7d", "refined-7d", "uploads-1d"])).toEqual([]);
  });

  it("lifecycleUpdateArgs 保留已有规则并追加缺失规则（PUT 整组替换）", () => {
    const [raw, , uploads] = setup.LIFECYCLE_RULES;
    const args = setup.lifecycleUpdateArgs("read-podcast-edge-raw", [DEFAULT_LIFECYCLE_RULE], [raw, uploads]);
    expect(args.slice(0, 6)).toEqual(["r2", "buckets", "lifecycle", "update", "read-podcast-edge-raw", "--rules"]);
    expect(JSON.parse(args[6])).toEqual([
      DEFAULT_LIFECYCLE_RULE,
      { id: "raw-7d", enabled: true, conditions: { prefix: "raw/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 604800 } } },
      {
        id: "uploads-1d",
        enabled: true,
        conditions: { prefix: "uploads/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
        abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86400 } },
      },
    ]);
  });

  it("findDatabaseId 只接受精确同名，parseLifecycleRules 拒绝非预期输出", () => {
    const databases = [{ name: "read-podcast-edge-old", uuid: "wrong" }, { name: "read-podcast-edge", uuid: DATABASE_ID }];
    expect(setup.findDatabaseId(databases, "read-podcast-edge")).toBe(DATABASE_ID);
    expect(setup.findDatabaseId([{ name: "read-podcast-edge-old", uuid: "wrong" }], "read-podcast-edge")).toBeNull();
    expect(setup.findDatabaseId(null, "read-podcast-edge")).toBeNull();
    expect(setup.parseLifecycleRules(FULL_LIFECYCLE)?.map(rule => rule.id)).toContain("raw-7d");
    expect(setup.parseLifecycleRules("not json")).toBeNull();
  });
});

describe("secrets 与部署值", () => {
  it("SECRET_PROMPTS 与 docs/DEPLOYMENT.md 的 secret 清单一致", () => {
    expect(setup.SECRET_PROMPTS.map(secret => secret.name)).toEqual([
      "GITHUB_TOKEN", "REFINER_API_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "DASHSCOPE_API_KEY", "NOTION_TOKEN",
    ]);
    for (const secret of setup.SECRET_PROMPTS) {
      expect(deploymentDoc).toContain(`wrangler secret put ${secret.name}`);
    }
  });

  it("deployEnvContent 写必填项、仅含已提供的可选值、含空白/井号的值加引号", () => {
    const content = setup.deployEnvContent({
      ...VALID_ENV,
      READ_PODCAST_GITHUB_PATH: "podcasts/transcripts",
      READ_PODCAST_TIME_ZONE: "Asia/Shanghai # test",
    });
    expect(content).toContain("READ_PODCAST_DOMAIN=podcast.mydomain.net");
    expect(content).toContain("READ_PODCAST_GITHUB_PATH=podcasts/transcripts");
    expect(content).toContain("READ_PODCAST_TIME_ZONE='Asia/Shanghai # test'");
    expect(content).not.toContain("READ_PODCAST_GITHUB_BRANCH");
    expect(content).not.toContain("READ_PODCAST_TRANSCRIPTION_LANGUAGE");
  });

  it("deployEnvContent 保留 TRANSCRIPTION_PROVIDER；dashscope 下转录地址可省略", () => {
    const content = setup.deployEnvContent({
      ...VALID_ENV,
      READ_PODCAST_TRANSCRIPTION_URL: "",
      READ_PODCAST_TRANSCRIPTION_PROVIDER: "dashscope",
    });
    expect(content).toContain("READ_PODCAST_TRANSCRIPTION_PROVIDER=dashscope");
    expect(content).not.toContain("READ_PODCAST_TRANSCRIPTION_URL");
  });

  it("重跑 env 步骤：已有 dashscope 部署不要求转录地址，且 provider 原样保留（不会悄悄回退到自托管）", async () => {
    let written: string | undefined;
    const code = await setup.runSetup(baseDeps({
      argv: ["--step", "env"],
      readFile: () => [
        "READ_PODCAST_DOMAIN=podcast.mydomain.net",
        "READ_PODCAST_GITHUB_OWNER=someone",
        "READ_PODCAST_GITHUB_REPO=notes",
        "READ_PODCAST_TRANSCRIPTION_PROVIDER=dashscope",
        "",
      ].join("\n"),
      writeFile: (_path, content) => {
        written = content;
      },
    }));
    expect(code).toBe(0);
    expect(written).toContain("READ_PODCAST_TRANSCRIPTION_PROVIDER=dashscope");
    expect(written).not.toContain("READ_PODCAST_TRANSCRIPTION_URL");
  });

  it("smokeChecks 与 docs/DEPLOYMENT.md 的边界 curl 一致", () => {
    expect(setup.smokeChecks("podcast.mydomain.net")).toEqual([
      { name: "public browse", url: "https://podcast.mydomain.net/", status: 200 },
      { name: "public api", url: "https://podcast.mydomain.net/api/public/articles", status: 200 },
      { name: "manage redirects to Access", url: "https://podcast.mydomain.net/manage", status: 302, locationIncludes: "cloudflareaccess.com" },
      { name: "control api redirects to Access", url: "https://podcast.mydomain.net/api/control/tasks", status: 302, locationIncludes: "cloudflareaccess.com" },
    ]);
  });
});

describe("runSetup 编排（CLI 全 mock）", () => {
  it("全新账号：创建 D1/R2、补齐三条规则、secrets 逐项经 stdin 写入、生成 .deploy.env", async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    let written: { path: string; content: string } | undefined;
    let lifecycleListCalls = 0;
    const secrets: Record<string, string> = { GITHUB_TOKEN: "s3cr3t-do-not-log", REFINER_API_KEY: "", CF_ACCESS_CLIENT_ID: "cid" };
    const deps = baseDeps({
      prompt: async query => (query.includes("READ_PODCAST_DOMAIN") ? VALID_ENV.READ_PODCAST_DOMAIN
        : query.includes("TRANSCRIPTION_URL") ? VALID_ENV.READ_PODCAST_TRANSCRIPTION_URL
        : query.includes("GITHUB_OWNER") ? VALID_ENV.READ_PODCAST_GITHUB_OWNER
        : VALID_ENV.READ_PODCAST_GITHUB_REPO),
      promptHidden: async query => Object.entries(secrets).find(([name]) => query.includes(`${name} (`))?.[1] ?? "",
      writeFile: (path, content) => {
        written = { path, content };
      },
      log: text => logs.push(text),
      error: text => errors.push(text),
      runCf: fakeCli([
        ["auth whoami", () => ({ status: 0, stdout: JSON.stringify({ authenticated: true, tokenValid: true, email: "owner@mydomain.net", accounts: [{ id: "a1", name: "my account" }] }), stderr: "" })],
        ["d1 list", () => ({ status: 0, stdout: "[]", stderr: "" })],
        ["d1 create", () => ({ status: 0, stdout: JSON.stringify({ uuid: DATABASE_ID, name: "read-podcast-edge" }), stderr: "" })],
        ["d1 migrations", () => ({ status: 0, stdout: "applied", stderr: "" })],
        ["r2 buckets get", () => ({ status: 1, stdout: "", stderr: "not found" })],
        ["r2 buckets create", () => ({ status: 0, stdout: "created", stderr: "" })],
        ["r2 buckets lifecycle get", () => {
          lifecycleListCalls++;
          return { status: 0, stdout: lifecycleListCalls === 1 ? lifecycleOutput() : FULL_LIFECYCLE, stderr: "" };
        }],
        ["r2 buckets lifecycle update", () => ({ status: 0, stdout: "updated", stderr: "" })],
        ["workers secrets list", () => ({ status: 1, stdout: "", stderr: "worker not found" })],
      ], calls),
      runWrangler: fakeCli([
        ["secret put", () => ({ status: 0, stdout: "uploaded", stderr: "" })],
      ], calls),
    });

    const code = await setup.runSetup(deps);
    expect(code).toBe(0);
    expect(errors).toEqual([]);

    const joined = calls.map(call => call.args.join(" "));
    expect(joined).toEqual([
      "auth whoami",
      "d1 list --name read-podcast-edge",
      "d1 create --name read-podcast-edge",
      `d1 migrations apply ${DATABASE_ID}`,
      "r2 buckets get read-podcast-edge-raw",
      "r2 buckets create --name read-podcast-edge-raw",
      "r2 buckets lifecycle get read-podcast-edge-raw",
      expect.stringMatching(/^r2 buckets lifecycle update read-podcast-edge-raw --rules .*raw-7d.*refined-7d.*uploads-1d/),
      "r2 buckets lifecycle get read-podcast-edge-raw",
      "workers secrets list --worker read-podcast-edge",
      "secret put GITHUB_TOKEN",
      "secret put CF_ACCESS_CLIENT_ID",
    ]);
    expect(calls.find(call => call.args[0] === "secret" && call.args[1] === "put" && call.args[2] === "GITHUB_TOKEN")?.input).toBe("s3cr3t-do-not-log");
    // REFINER_API_KEY 留空被跳过；密钥值绝不出现在任何输出里
    expect(logs.join("\n")).toContain("Skipped REFINER_API_KEY");
    expect(logs.join("\n")).not.toContain("s3cr3t-do-not-log");
    expect(logs.join("\n")).toContain("Parts the script cannot do");

    expect(written?.path).toBe("/nonexistent/.deploy.env");
    expect(written?.content).toContain("READ_PODCAST_DOMAIN=podcast.mydomain.net");
    expect(written?.content).toContain("READ_PODCAST_GITHUB_OWNER=someone");
    // 非交互且未显式要求：冒烟只提示，不联网
    expect(logs.join("\n")).toContain("Smoke test skipped");
  });

  it("资源已存在：跳过 create/add/put，可选部署值原样保留", async () => {
    const calls: { args: string[]; input?: string }[] = [];
    let written: { path: string; content: string } | undefined;
    const deps = baseDeps({
      deployEnvPath: "/fixture/.deploy.env",
      readFile: () => [
        "READ_PODCAST_DOMAIN=old.mydomain.net",
        "READ_PODCAST_TRANSCRIPTION_URL=https://transcribe.mydomain.net",
        "READ_PODCAST_GITHUB_OWNER=someone",
        "READ_PODCAST_GITHUB_REPO=notes",
        "READ_PODCAST_GITHUB_BRANCH=dev",
        "",
      ].join("\n"),
      writeFile: (path, content) => {
        written = { path, content };
      },
      runCf: fakeCli([
        ["auth whoami", () => ({ status: 0, stdout: JSON.stringify({ authenticated: true, accounts: [{ name: "a" }] }), stderr: "" })],
        ["d1 list", () => ({ status: 0, stdout: JSON.stringify([{ name: "read-podcast-edge", uuid: DATABASE_ID }]), stderr: "" })],
        ["d1 migrations", () => ({ status: 0, stdout: "No migrations to apply", stderr: "" })],
        ["r2 buckets get", () => ({ status: 0, stdout: "{}", stderr: "" })],
        ["r2 buckets lifecycle get", () => ({ status: 0, stdout: FULL_LIFECYCLE, stderr: "" })],
        ["workers secrets list", () => ({ status: 0, stdout: JSON.stringify([{ name: "GITHUB_TOKEN" }]), stderr: "" })],
      ], calls),
    });

    const code = await setup.runSetup(deps);
    expect(code).toBe(0);
    const joined = calls.map(call => call.args.join(" "));
    expect(joined).toEqual([
      "auth whoami",
      "d1 list --name read-podcast-edge",
      `d1 migrations apply ${DATABASE_ID}`,
      "r2 buckets get read-podcast-edge-raw",
      "r2 buckets lifecycle get read-podcast-edge-raw",
      "workers secrets list --worker read-podcast-edge",
    ]);
    expect(joined.some(args => args.includes("create") || args.includes("update") || args.includes("put"))).toBe(false);
    expect(written?.content).toContain("READ_PODCAST_DOMAIN=old.mydomain.net");
    expect(written?.content).toContain("READ_PODCAST_GITHUB_BRANCH=dev");
  });

  it("占位值被 buildDeployArgs 总闸拒绝并重新提问", async () => {
    const errors: string[] = [];
    const writes: string[] = [];
    let round = 0;
    const deps = baseDeps({
      argv: ["--step", "env"],
      isInteractive: true,
      prompt: async query => {
        if (query.includes("READ_PODCAST_DOMAIN")) return ++round === 1 ? "your-domain.example" : VALID_ENV.READ_PODCAST_DOMAIN;
        if (query.includes("READ_PODCAST_TRANSCRIPTION_URL")) return VALID_ENV.READ_PODCAST_TRANSCRIPTION_URL;
        if (query.includes("READ_PODCAST_GITHUB_OWNER")) return VALID_ENV.READ_PODCAST_GITHUB_OWNER;
        return VALID_ENV.READ_PODCAST_GITHUB_REPO;
      },
      error: text => errors.push(text),
      writeFile: (_path, content) => {
        writes.push(content);
      },
    });

    const code = await setup.runSetup(deps);
    expect(code).toBe(0);
    expect(errors.join("\n")).toContain("documentation placeholder");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("READ_PODCAST_DOMAIN=podcast.mydomain.net");
  });

  it("cf 失败时停在该步并以 1 退出", async () => {
    const calls: { args: string[] }[] = [];
    const deps = baseDeps({
      runCf: fakeCli([
        ["auth whoami", () => ({ status: 0, stdout: JSON.stringify({ authenticated: true }), stderr: "" })],
        ["d1 list", () => ({ status: 1, stdout: "", stderr: "boom" })],
      ], calls),
    });
    const code = await setup.runSetup(deps);
    expect(code).toBe(1);
    expect(calls.map(call => call.args.join(" "))).toEqual(["auth whoami", "d1 list --name read-podcast-edge"]);
  });

  it("whoami 退出码为 0 但令牌失效时仍判定未登录", async () => {
    const errors: string[] = [];
    const deps = baseDeps({
      error: text => errors.push(text),
      runCf: fakeCli([
        ["auth whoami", () => ({ status: 0, stdout: JSON.stringify({ authenticated: true, tokenValid: false }), stderr: "" })],
      ], []),
    });
    expect(await setup.runSetup(deps)).toBe(1);
    expect(errors.join("\n")).toContain("npx cf auth login");
  });

  it("--step smoke 显式执行：边界检查全过为 0，控制面匿名可达为 1", async () => {
    const deps = baseDeps({
      argv: ["--step", "smoke"],
      readFile: () => "READ_PODCAST_DOMAIN=podcast.mydomain.net\n",
      fetch: (async (url: string) => ({
        status: url.endsWith("/manage") || url.includes("/api/control/") ? 302 : 200,
        headers: { get: (name: string) => (name === "location" ? "https://mydomain.cloudflareaccess.com/cdn-cgi/access/login" : null) },
      })) as unknown as Deps["fetch"],
    });
    expect(await setup.runSetup(deps)).toBe(0);

    const broken = baseDeps({
      argv: ["--step", "smoke"],
      readFile: () => "READ_PODCAST_DOMAIN=podcast.mydomain.net\n",
      fetch: (async () => ({ status: 200, headers: { get: () => null } })) as unknown as Deps["fetch"],
    });
    expect(await setup.runSetup(broken)).toBe(1);
  });
});

describe("子进程行为（不触网）", () => {
  const run = (args: string[]) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("READ_PODCAST_")));
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      env: { ...clean, READ_PODCAST_DEPLOY_ENV: "/nonexistent/.deploy.env" },
      encoding: "utf-8",
    });
  };

  it("未知步骤以 1 退出", () => {
    const result = run(["--step", "bogus"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown step: bogus");
  });

  it("--step checklist 完全离线可运行", () => {
    const result = run(["--step", "checklist"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Parts the script cannot do");
    expect(result.stdout).toContain("Cloudflare Tunnel");
  });

  it("非交互 --step env 缺值时拒绝并提示手工编辑", () => {
    const result = run(["--step", "env"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Edit .deploy.env by hand");
  });

  it("非交互 --step smoke 无域名时以 1 退出", () => {
    const result = run(["--step", "smoke"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot determine the domain");
  });
});
