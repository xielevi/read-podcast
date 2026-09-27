#!/usr/bin/env node
// 部署初始化入口（npm run setup）：社区用户从零开始的一次一条命令初始化。
//
// 每一步都可重复执行：已存在的资源（D1、R2 桶、生命周期规则、secrets、.deploy.env
// 里的值）直接跳过或以当前值作为默认。部署值校验复用 scripts/deploy.mjs 的逻辑，
// 文档占位值一律拒绝。secrets 只经 stdin 传给 wrangler secret put，不回显、不写入
// 任何文件。Access 与 Tunnel 属于脚本做不了的部分，只输出手动清单；见 docs/DEPLOYMENT.md。
//
//   npm run setup                      交互式执行全部步骤
//   npm run setup -- --step d1         只执行某一步（login|d1|r2|secrets|env|checklist|smoke，可重复传）
//   npm run setup -- --smoke           追加/单独执行 Access 边界冒烟测试（部署完成后才有意义）
//   npm run setup -- --help            帮助
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { buildDeployArgs, parseDeployEnv } from "./deploy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const STEP_ORDER = ["login", "d1", "r2", "secrets", "env", "checklist", "smoke"];

// 与 wrangler.jsonc 注释、docs/DEPLOYMENT.md「R2 and lifecycle rules」的三条命令保持一致
// （test/setup.test.ts 校验三者同步）。
export const LIFECYCLE_RULES = [
  { name: "raw-7d", prefix: "raw/", expireDays: 7 },
  { name: "refined-7d", prefix: "refined/", expireDays: 7 },
  { name: "uploads-1d", prefix: "uploads/", expireDays: 1, abortMultipartDays: 1 },
];

export const SECRET_PROMPTS = [
  { name: "GITHUB_TOKEN", hint: "fine-grained token with Contents: Read and write on the manuscript repository" },
  { name: "REFINER_API_KEY", hint: "key of your OpenAI-compatible Refinement Provider" },
  { name: "R2_ACCOUNT_ID", hint: "account id of the read-only R2 credential used to sign presigned upload URLs" },
  { name: "R2_ACCESS_KEY_ID", hint: "access key id of the same credential" },
  { name: "R2_SECRET_ACCESS_KEY", hint: "secret access key of the same credential" },
  { name: "CF_ACCESS_CLIENT_ID", hint: "Client ID of the Access service token for the transcription hostname" },
  { name: "CF_ACCESS_CLIENT_SECRET", hint: "Client Secret of the same token" },
];

const REQUIRED_DEPLOY_KEYS = [
  "READ_PODCAST_DOMAIN",
  "READ_PODCAST_TRANSCRIPTION_URL",
  "READ_PODCAST_GITHUB_OWNER",
  "READ_PODCAST_GITHUB_REPO",
];
const OPTIONAL_DEPLOY_KEYS = [
  "READ_PODCAST_GITHUB_BRANCH",
  "READ_PODCAST_GITHUB_PATH",
  "READ_PODCAST_TRANSCRIPTION_LANGUAGE",
  "READ_PODCAST_TIME_ZONE",
];

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const USAGE = `Usage: npm run setup [-- --step <name>]... [--smoke] [--help]

Interactive, idempotent deployment setup for a fresh Cloudflare account.
Existing resources are detected and skipped.

Steps (run in this order):
  login       verify \`wrangler\` authentication
  d1          create the D1 database (by wrangler.jsonc database_name) and apply remote migrations
  r2          create the R2 bucket and the three lifecycle rules, then verify them
  secrets     prompt for each secret (input hidden, never written to any file)
  env         generate .deploy.env (deployment values, refused if placeholder)
  checklist   print the manual Cloudflare Access / Tunnel steps the script cannot do
  smoke       boundary smoke test against your domain (meaningful after \`npm run deploy\`)`;

/** 解析命令行参数；未知参数或未知步骤名抛错。steps 始终按 STEP_ORDER 规范排序。 */
export function parseSetupArgs(argv) {
  const stepNames = [];
  let smokeFlag = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--smoke") {
      smokeFlag = true;
    } else if (arg === "--step") {
      const value = argv[++i];
      if (!value) throw new Error("--step requires a step name");
      stepNames.push(value);
    } else if (arg.startsWith("--step=")) {
      const value = arg.slice("--step=".length);
      if (!value) throw new Error("--step requires a step name");
      stepNames.push(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const unknown = stepNames.filter(name => !STEP_ORDER.includes(name));
  if (unknown.length) {
    throw new Error(`Unknown step: ${unknown.join(", ")} (available: ${STEP_ORDER.join(", ")})`);
  }
  const steps = stepNames.length ? STEP_ORDER.filter(name => stepNames.includes(name)) : [...STEP_ORDER];
  // `npm run setup -- --smoke` 单独使用时只跑冒烟（部署后的常态用法）；与 --step 同用则追加。
  if (smokeFlag && !stepNames.length) return { steps: ["smoke"], help, smokeExplicit: true };
  if (smokeFlag && !steps.includes("smoke")) steps.push("smoke");
  return { steps, help, smokeExplicit: smokeFlag || stepNames.includes("smoke") };
}

/** 解析 JSONC：剥离字符串之外的单行与块注释后交给 JSON.parse。 */
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out);
}

/** wrangler 可能把警告打在 JSON 前：先直接 parse，失败再从第一个 { 或 [ 截取；解析不了返回 null。 */
export function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = [...text].findIndex(ch => ch === "{" || ch === "[");
    if (start === -1) return null;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      return null;
    }
  }
}

/** 从 wrangler.jsonc 配置对象取本脚本要操作的资源名；缺失即抛错。 */
export function resourcesFromConfig(config) {
  const d1 = config.d1_databases?.[0];
  const r2 = config.r2_buckets?.[0];
  if (!d1?.database_name) throw new Error("wrangler.jsonc is missing d1_databases[0].database_name");
  if (!r2?.bucket_name) throw new Error("wrangler.jsonc is missing r2_buckets[0].bucket_name");
  return {
    workerName: config.name,
    d1Binding: d1.binding,
    d1DatabaseName: d1.database_name,
    r2BucketName: r2.bucket_name,
  };
}

/** `wrangler r2 bucket lifecycle list` 只输出表格：取每行第一个非空列作为规则 id。 */
export function parseLifecycleRuleIds(text) {
  const ids = [];
  for (const rawLine of text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const first = (rawLine.split(/[│|]/).find(cell => cell.trim()) ?? "").trim();
    // 规则 id 是简单名字：排除表头 "name" 与 ┌─┬┐ 边框、说明文字等非 id 行
    if (!first || !/^[a-z0-9._-]+$/i.test(first) || /^name$/i.test(first)) continue;
    if (!ids.includes(first)) ids.push(first);
  }
  return ids;
}

export function missingLifecycleRules(existingIds, rules = LIFECYCLE_RULES) {
  return rules.filter(rule => !existingIds.includes(rule.name));
}

export function lifecycleAddArgs(bucket, rule) {
  return [
    "r2", "bucket", "lifecycle", "add", bucket, rule.name, rule.prefix,
    "--expire-days", String(rule.expireDays),
    ...(rule.abortMultipartDays ? ["--abort-multipart-days", String(rule.abortMultipartDays)] : []),
  ];
}

/** 生成 .deploy.env 内容：必填四项 + 当前已有的可选值；含空白或 # 的值加单引号。 */
export function deployEnvContent(values) {
  const value = key => (values[key] ?? "").trim();
  const quoted = text => (/[\s#'"]/.test(text) ? `'${text}'` : text);
  const lines = [
    "# 部署值（npm run deploy 读取）。由 npm run setup 生成；同名环境变量优先。见 docs/DEPLOYMENT.md。",
    "",
    `READ_PODCAST_DOMAIN=${quoted(value("READ_PODCAST_DOMAIN"))}`,
    `READ_PODCAST_TRANSCRIPTION_URL=${quoted(value("READ_PODCAST_TRANSCRIPTION_URL"))}`,
    `READ_PODCAST_GITHUB_OWNER=${quoted(value("READ_PODCAST_GITHUB_OWNER"))}`,
    `READ_PODCAST_GITHUB_REPO=${quoted(value("READ_PODCAST_GITHUB_REPO"))}`,
  ];
  const optional = OPTIONAL_DEPLOY_KEYS.filter(key => value(key));
  if (optional.length) {
    lines.push("", "# 可选");
    for (const key of optional) lines.push(`${key}=${quoted(value(key))}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Access 边界冒烟测试：与 docs/DEPLOYMENT.md「Smoke test」第 1 组 curl 一致。 */
export function smokeChecks(domain) {
  const base = `https://${domain}`;
  return [
    { name: "public browse", url: `${base}/`, status: 200 },
    { name: "public api", url: `${base}/api/public/articles`, status: 200 },
    { name: "manage redirects to Access", url: `${base}/manage`, status: 302, locationIncludes: "cloudflareaccess.com" },
    { name: "control api redirects to Access", url: `${base}/api/control/tasks`, status: 302, locationIncludes: "cloudflareaccess.com" },
  ];
}

const DEPLOY_PROMPTS = {
  READ_PODCAST_DOMAIN: "application domain (a bare hostname such as podcast.mydomain.net, no scheme or path)",
  READ_PODCAST_TRANSCRIPTION_URL: "transcription service URL (https://transcribe.your-domain.example)",
  READ_PODCAST_GITHUB_OWNER: "manuscript repository owner (your-github-username)",
  READ_PODCAST_GITHUB_REPO: "manuscript repository name (your-manuscript-repository)",
};

/** 单项校验，返回错误消息或 null；总闸由 scripts/deploy.mjs 的 buildDeployArgs 把守。 */
function fieldError(key, text) {
  if (!text) return `${key} is required`;
  if (key === "READ_PODCAST_DOMAIN" && !DOMAIN_RE.test(text)) {
    return `${key} must be a bare hostname without scheme or path (got ${text})`;
  }
  if (key === "READ_PODCAST_TRANSCRIPTION_URL" && !/^https:\/\/[^\s/]+/i.test(text)) {
    return `${key} must be an https:// URL (got ${text})`;
  }
  return null;
}

/** 交互式收集部署值：当前值作为默认，逐项校验，最后用 buildDeployArgs 总闸把关。 */
async function collectDeployValues(deps, current) {
  for (let round = 0; round < 3; round++) {
    const values = {};
    let fieldProblem = null;
    for (const key of REQUIRED_DEPLOY_KEYS) {
      const existing = (current[key] ?? "").trim();
      const answer = (await deps.prompt(`${DEPLOY_PROMPTS[key]}\n  ${key}${existing ? ` [${existing}]` : ""}: `, existing)) ?? existing;
      const text = answer.trim() || existing;
      fieldProblem = fieldError(key, text);
      if (fieldProblem) break;
      values[key] = text;
    }
    if (!fieldProblem) {
      try {
        buildDeployArgs({ ...values, ...Object.fromEntries(OPTIONAL_DEPLOY_KEYS.map(key => [key, current[key] ?? ""])) }, []);
        return values;
      } catch (error) {
        deps.error(String(error instanceof Error ? error.message : error));
      }
    } else {
      deps.error(`✘ ${fieldProblem}`);
    }
    if (!deps.isInteractive || round === 2) {
      deps.error("Edit .deploy.env by hand, then rerun `npm run setup -- --step env`.");
      return null;
    }
  }
  return null;
}

function ok(message, deps) {
  if (message) deps.log(message);
  return { ok: true };
}

function fail(message, deps) {
  deps.error(`✘ ${message}`);
  return { ok: false };
}

export async function runSetup(deps) {
  let parsed;
  try {
    parsed = parseSetupArgs(deps.argv ?? []);
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (parsed.help) {
    deps.log(USAGE);
    return 0;
  }

  let resources;
  try {
    resources = resourcesFromConfig(parseJsonc(deps.readConfig()));
  } catch (error) {
    deps.error(`Cannot read wrangler.jsonc: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  const run = async (args, options = {}) => {
    const result = await deps.runWrangler(args, options);
    // 检查类命令成功时静默（步骤自己输出结论）；失败或变更类命令原样展示 wrangler 输出。
    if (result.status === 0 && options.quiet) return result;
    for (const text of [result.stdout, result.stderr]) {
      const trimmed = (text ?? "").trim();
      if (trimmed) deps.log(trimmed);
    }
    return result;
  };

  // ── login ──
  const stepLogin = async () => {
    deps.log("Checking wrangler authentication…");
    const result = await run(["whoami", "--json"], { input: "", quiet: true });
    if (result.status !== 0) {
      return fail("Not logged in. Run `npx wrangler login` in an interactive terminal (or set CLOUDFLARE_API_TOKEN), then rerun.", deps);
    }
    const info = extractJson(result.stdout);
    if (!info) return fail("could not parse `wrangler whoami --json` output.", deps);
    const account = info.accounts?.[0]?.name ?? "(unknown account)";
    return ok(`✓ Logged in${info.email ? ` as ${info.email}` : ""}, account: ${account}`, deps);
  };

  // ── d1 ──
  const stepD1 = async () => {
    deps.log(`Checking D1 database ${resources.d1DatabaseName}…`);
    const list = await run(["d1", "list", "--json"], { input: "", quiet: true });
    if (list.status !== 0) return fail(`wrangler d1 list failed (exit ${list.status}).`, deps);
    const databases = extractJson(list.stdout);
    if (!Array.isArray(databases)) return fail("could not parse `wrangler d1 list` output.", deps);
    if (databases.some(db => db.name === resources.d1DatabaseName)) {
      deps.log(`D1 database ${resources.d1DatabaseName} already exists, skipping creation.`);
    } else {
      const created = await run(["d1", "create", resources.d1DatabaseName], { input: "" });
      if (created.status !== 0) return fail(`wrangler d1 create failed (exit ${created.status}).`, deps);
    }
    deps.log("Applying remote D1 migrations (only unapplied ones run; safe to repeat)…");
    const applied = await run(["d1", "migrations", "apply", resources.d1Binding, "--remote"], { input: "" });
    if (applied.status !== 0) return fail(`wrangler d1 migrations apply failed (exit ${applied.status}).`, deps);
    return ok("✓ D1 ready.", deps);
  };

  // ── r2 ──
  const stepR2 = async () => {
    deps.log(`Checking R2 bucket ${resources.r2BucketName}…`);
    const info = await run(["r2", "bucket", "info", resources.r2BucketName, "--json"], { input: "", quiet: true });
    if (info.status === 0) {
      deps.log(`R2 bucket ${resources.r2BucketName} already exists, skipping creation.`);
    } else {
      const created = await run(["r2", "bucket", "create", resources.r2BucketName], { input: "" });
      if (created.status !== 0) return fail(`wrangler r2 bucket create failed (exit ${created.status}).`, deps);
    }
    const listArgs = ["r2", "bucket", "lifecycle", "list", resources.r2BucketName];
    const listed = await run(listArgs, { input: "", quiet: true });
    if (listed.status !== 0) return fail(`wrangler r2 bucket lifecycle list failed (exit ${listed.status}).`, deps);
    const missing = missingLifecycleRules(parseLifecycleRuleIds(listed.stdout));
    if (!missing.length) {
      return ok(`✓ R2 ready, all three lifecycle rules already exist: ${LIFECYCLE_RULES.map(rule => rule.name).join(", ")}`, deps);
    }
    for (const rule of missing) {
      const added = await run(lifecycleAddArgs(resources.r2BucketName, rule), { input: "" });
      if (added.status !== 0) return fail(`adding lifecycle rule ${rule.name} failed (exit ${added.status}).`, deps);
    }
    const verified = await run(listArgs, { input: "", quiet: true });
    if (verified.status !== 0) return fail("could not verify lifecycle rules.", deps);
    const stillMissing = missingLifecycleRules(parseLifecycleRuleIds(verified.stdout));
    if (stillMissing.length) return fail(`lifecycle verification failed, missing: ${stillMissing.map(rule => rule.name).join(", ")}`, deps);
    return ok(`✓ R2 ready, lifecycle verified: ${LIFECYCLE_RULES.map(rule => rule.name).join(", ")}`, deps);
  };

  // ── secrets ──
  const stepSecrets = async () => {
    deps.log("Setting Worker secrets (input is hidden and never written to any file)…");
    let existing = [];
    const listed = await run(["secret", "list", "--format", "json"], { input: "", quiet: true });
    if (listed.status === 0) {
      try {
        existing = extractJson(listed.stdout).map(secret => secret.name);
      } catch {
        existing = [];
      }
    } else {
      deps.log("No deployed Worker yet — secrets will create one; `npm run deploy` replaces it later.");
    }
    for (const { name, hint } of SECRET_PROMPTS) {
      const already = existing.includes(name);
      const query = already
        ? `${name} is already set (value hidden). Press Enter to keep it, or type a new value.\n  ${name} (${hint}): `
        : `${name} (${hint})\n  ${name}: `;
      const secret = await deps.promptHidden(query);
      if (!secret) {
        deps.log(`Skipped ${name}${already ? " (kept)" : ""}.`);
        continue;
      }
      const put = await run(["secret", "put", name], { input: secret });
      if (put.status !== 0) return fail(`writing secret ${name} failed (exit ${put.status}).`, deps);
      deps.log(`✓ ${name} written (value not recorded anywhere).`);
    }
    return ok(undefined, deps);
  };

  // ── env ──
  const stepEnv = async () => {
    let current = {};
    try {
      current = parseDeployEnv(await deps.readFile(deps.deployEnvPath));
    } catch {
      current = {};
    }
    deps.log(`Generating ${deps.deployEnvPath} (git-ignored; existing values are kept as defaults)…`);
    const values = await collectDeployValues(deps, current);
    if (!values) return { ok: false };
    await deps.writeFile(deps.deployEnvPath, deployEnvContent({ ...current, ...values }));
    return ok(`✓ Wrote ${deps.deployEnvPath}. Optional values (branch/path/language/time zone) can be edited there; environment variables still take precedence.`, deps);
  };

  // ── checklist ──
  const stepChecklist = () => {
    deps.log(`
Parts the script cannot do (finish these by hand, see docs/DEPLOYMENT.md):

1. Cloudflare Access for the control plane (Zero Trust -> Access -> Applications):
   one self-hosted application covering exactly ${"<your-domain>"}/manage* and
   /api/control/*, with an Allow policy for your own identity. Do NOT cover /
   or /api/public/* (Public Browse Mode).
2. Access service token for the transcription hostname (Zero Trust -> Access ->
   Service Tokens), bound by a Service Auth policy on that hostname. Its Client
   ID / Secret are the CF_ACCESS_* secrets written above.
3. Cloudflare Tunnel (Zero Trust -> Networks -> Tunnels), remotely managed:
   public hostname <transcribe.your-domain> -> http://127.0.0.1:28100, and the
   cloudflared connector running on the transcription host.
4. Transcription Service on that host: git clone this repository, then run
   deploy/macos/install.sh (zero configuration, no credentials stored).
5. Deploy: npm run deploy -- --dry-run, then npm run deploy.
6. Before your first generation: open /manage, sign in through Access, and point
   the Refinement Provider in Settings at your own API.
7. Optional: CI deployment via GitHub Actions repository variables and a
   "production" environment (docs/DEPLOYMENT.md, Continuous deployment).

After deploying, run \`npm run setup -- --smoke\` for the boundary smoke test.`);
    return ok(undefined, deps);
  };

  // ── smoke ──
  const stepSmoke = async (explicit) => {
    let domain = process.env.READ_PODCAST_DOMAIN?.trim();
    if (!domain) {
      try {
        domain = parseDeployEnv(await deps.readFile(deps.deployEnvPath)).READ_PODCAST_DOMAIN?.trim();
      } catch {
        domain = undefined;
      }
    }
    if (!domain) {
      if (explicit) return fail("Cannot determine the domain: finish the env step or export READ_PODCAST_DOMAIN.", deps);
      return ok("Smoke test skipped (no domain known). Run `npm run setup -- --smoke` after deploying.", deps);
    }
    if (!explicit) {
      if (!deps.isInteractive) {
        return ok("Smoke test skipped (non-interactive). Run `npm run setup -- --smoke` after deploying.", deps);
      }
      const answer = (await deps.prompt("Run the boundary smoke test now? Only meaningful after `npm run deploy` (y/N): ", "")) ?? "";
      if (!/^y(es)?$/i.test(answer.trim())) return ok("Smoke test skipped.", deps);
    }
    deps.log(`Running boundary smoke test against ${domain}…`);
    let failures = 0;
    for (const check of smokeChecks(domain)) {
      try {
        const response = await deps.fetch(check.url, { redirect: "manual" });
        const location = response.headers.get("location") ?? "";
        const statusOk = response.status === check.status;
        const locationOk = !check.locationIncludes || location.includes(check.locationIncludes);
        if (statusOk && locationOk) {
          deps.log(`✓ ${check.name}: ${response.status}${check.locationIncludes ? ` -> ${location}` : ""}`);
        } else {
          failures++;
          deps.error(`✘ ${check.name}: expected ${check.status}${check.locationIncludes ? ` with ${check.locationIncludes} redirect` : ""}, got ${response.status} ${location}`);
        }
      } catch (error) {
        failures++;
        deps.error(`✘ ${check.name}: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (failures) return fail(`${failures} smoke check(s) failed.`, deps);
    return ok("✓ Boundary smoke test passed.", deps);
  };

  const steps = {
    login: stepLogin,
    d1: stepD1,
    r2: stepR2,
    secrets: stepSecrets,
    env: stepEnv,
    checklist: stepChecklist,
    smoke: () => stepSmoke(parsed.smokeExplicit),
  };

  for (const name of parsed.steps) {
    deps.log(`\n== ${name} ==`);
    const result = await steps[name]();
    if (!result.ok) {
      deps.error(`\nStopped at step "${name}". Fix the problem and rerun \`npm run setup\` — completed steps are skipped automatically.`);
      return 1;
    }
  }
  return 0;
}

// ── 真实依赖：进程内默认实现 ──

function defaultRunWrangler(args, { input } = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: ROOT,
    input: input ?? "",
    encoding: "utf-8",
    shell: process.platform === "win32",
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
}

function defaultPrompt(query, defaultValue) {
  if (!process.stdin.isTTY) return defaultValue;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise(resolve => {
    rl.on("SIGINT", () => process.exit(130));
    rl.question(query, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

/** 密钥输入：TTY 上进入 raw 模式逐字符收集、不回显；非 TTY（管道）直接读行。 */
function defaultPromptHidden(query) {
  return new Promise(resolve => {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY) {
      output.write(query);
      const rl = createInterface({ input, terminal: false });
      rl.once("line", line => {
        rl.close();
        resolve(line);
      });
      // 管道在无换行时直接结束：EOF 视为空输入
      rl.once("close", () => resolve(""));
      return;
    }
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    let value = "";
    const cleanup = () => {
      input.removeListener("data", onData);
      input.setRawMode(wasRaw);
      output.write("\n");
    };
    const onData = ch => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        cleanup();
        resolve(value);
      } else if (ch === "\u0003") {
        cleanup();
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    output.write(query);
    input.on("data", onData);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runSetup({
    argv: process.argv.slice(2),
    isInteractive: process.stdin.isTTY === true,
    deployEnvPath: process.env.READ_PODCAST_DEPLOY_ENV || `${ROOT}/.deploy.env`,
    readConfig: () => readFileSync(`${ROOT}/wrangler.jsonc`, "utf-8"),
    readFile: path => readFileSync(path, "utf-8"),
    writeFile: (path, content) => writeFileSync(path, content),
    runWrangler: defaultRunWrangler,
    prompt: defaultPrompt,
    promptHidden: defaultPromptHidden,
    fetch: (url, init) => fetch(url, init),
    log: console.log,
    error: console.error,
  }).then(
    code => process.exit(code),
    error => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    },
  );
}
