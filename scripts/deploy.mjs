#!/usr/bin/env node
// 维护者生产部署入口（npm run deploy:production）：把部署者自己的值注入 wrangler deploy。
//
// wrangler.jsonc 只保存与部署者无关的结构；域名、转录服务地址与稿件仓库这类
// 每个部署各不相同的值，从环境变量或仓库根目录下不提交的 .deploy.env 读取
// （环境变量优先；READ_PODCAST_DEPLOY_ENV 可指定其他文件），再以 --domain / --var 传给 wrangler。
// 见 docs/DEPLOYMENT.md。
//
//   npm run deploy:production                     部署
//   npm run deploy:production -- --dry-run        只打包校验，不上线（其余参数原样传给 wrangler deploy）
//   node scripts/deploy.mjs --print-args          打印将执行的 wrangler 参数（JSON）后退出
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEPLOY_ENV_FILE = ".deploy.env";

// 部署输入 → Worker vars。键名刻意不以 GITHUB_ 开头：GitHub Actions 不允许这样命名变量。
const REQUIRED = {
  READ_PODCAST_DOMAIN: null, // → --domain（Custom Domain）
  READ_PODCAST_TRANSCRIPTION_URL: "TRANSCRIPTION_SERVICE_URL",
  READ_PODCAST_GITHUB_OWNER: "GITHUB_OWNER",
  READ_PODCAST_GITHUB_REPO: "GITHUB_REPO",
};
const OPTIONAL = {
  READ_PODCAST_GITHUB_BRANCH: "GITHUB_BRANCH",
  READ_PODCAST_GITHUB_PATH: "GITHUB_PODCAST_PATH",
  READ_PODCAST_TRANSCRIPTION_LANGUAGE: "TRANSCRIPTION_LANGUAGE",
  READ_PODCAST_TRANSCRIPTION_PROVIDER: "TRANSCRIPTION_PROVIDER",
  READ_PODCAST_TIME_ZONE: "MANUSCRIPT_TIME_ZONE",
};

const TRANSCRIPTION_PROVIDERS = new Set(["self-hosted", "dashscope"]);

/** 极简 dotenv：KEY=VALUE，# 注释，值可用单 / 双引号包裹。 */
export function parseDeployEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function isPlaceholder(value) {
  return /(^|\.)(your-domain\.)?example(\.[a-z]+)?$/i.test(value) || /your-(github-username|manuscript-repository|domain)/i.test(value);
}

/** 校验部署输入并生成 wrangler deploy 的参数；输入不完整或仍是占位值时抛错。 */
export function buildDeployArgs(input, passthrough = []) {
  const errors = [];
  const value = key => (input[key] ?? "").trim();
  const provider = (value("READ_PODCAST_TRANSCRIPTION_PROVIDER") || "self-hosted").toLowerCase();

  for (const key of Object.keys(REQUIRED)) {
    // 转录地址只在自托管路径下必需：dashscope 由 Worker 直连百炼，没有转录主机。
    if (key === "READ_PODCAST_TRANSCRIPTION_URL" && provider === "dashscope") continue;
    if (!value(key)) errors.push(`${key} is required`);
    else if (isPlaceholder(value(key).replace(/^https?:\/\//, "").replace(/\/.*$/, ""))) errors.push(`${key} is still a documentation placeholder (${value(key)})`);
  }

  const domain = value("READ_PODCAST_DOMAIN");
  if (domain && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
    errors.push(`READ_PODCAST_DOMAIN must be a bare hostname such as podcast.mydomain.net, without scheme or path (got ${domain})`);
  }
  const transcription = value("READ_PODCAST_TRANSCRIPTION_URL");
  if (transcription && !/^https:\/\/[^\s/]+/i.test(transcription)) {
    errors.push(`READ_PODCAST_TRANSCRIPTION_URL must be an https:// URL (got ${transcription})`);
  }
  if (value("READ_PODCAST_TRANSCRIPTION_PROVIDER") && !TRANSCRIPTION_PROVIDERS.has(provider)) {
    errors.push(`READ_PODCAST_TRANSCRIPTION_PROVIDER must be self-hosted or dashscope (got ${value("READ_PODCAST_TRANSCRIPTION_PROVIDER")})`);
  }
  if (errors.length) throw new Error(`Deployment values are incomplete:\n  - ${errors.join("\n  - ")}\nSee docs/DEPLOYMENT.md (Deployment values).`);

  const args = ["deploy", "--domain", domain, "--var", "CONTROL_AUTH_MODE:access"];
  for (const [key, varName] of Object.entries({ ...REQUIRED, ...OPTIONAL })) {
    if (!varName || !value(key)) continue;
    args.push("--var", `${varName}:${value(key)}`);
  }
  return [...args, ...passthrough];
}

function loadInput() {
  const file = process.env.READ_PODCAST_DEPLOY_ENV || new URL(`../${DEPLOY_ENV_FILE}`, import.meta.url);
  const fromFile = existsSync(file) ? parseDeployEnv(readFileSync(file, "utf8")) : {};
  const fromEnv = Object.fromEntries(
    Object.keys({ ...REQUIRED, ...OPTIONAL }).filter(key => process.env[key]).map(key => [key, process.env[key]]),
  );
  return { ...fromFile, ...fromEnv };
}

function main() {
  const argv = process.argv.slice(2);
  const printOnly = argv.includes("--print-args");
  const passthrough = argv.filter(arg => arg !== "--print-args");

  let args;
  try {
    args = buildDeployArgs(loadInput(), passthrough);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (printOnly) {
    console.log(JSON.stringify(args));
    return;
  }
  const result = spawnSync("npx", ["wrangler", ...args], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
