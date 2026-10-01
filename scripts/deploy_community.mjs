#!/usr/bin/env node
// 社区部署入口（npm run deploy）：Deploy to Cloudflare / Workers Builds 与命令行共用。
// 维护者 custom-domain + Access 生产发布用 npm run deploy:production（scripts/deploy.mjs）。
//
// 仓库里的 wrangler.jsonc 保持生产形态（workers_dev=false）；这里在同目录写一份临时配置：
// - 打开 workers.dev，控制面由 CONTROL_AUTH_* Basic Auth 守护（缺凭据 fail closed）；
// - 去掉部署页以 secret 收集的同名 vars（同名 plain var 与 secret 会被 Cloudflare 拒绝）并 keep_vars，
//   部署者在 dashboard 设置的变量（如 TRANSCRIPTION_PROVIDER）不会被重新部署抹掉；
// - Workflow 名跟随 Worker 名、R2_BUCKET_NAME 跟随 bucket_name：部署页改名或同账号多实例时不串用资源。
// 步骤：D1 remote 迁移（按 DB binding）与 wrangler deploy（首次部署由 wrangler 自动创建 D1/R2，
// 此时先部署再迁移）→ R2 生命周期规则（幂等；失败只告警）。
//
//   npm run deploy                     部署
//   npm run deploy -- --dry-run        只打包校验，不碰远端
//   node scripts/deploy_community.mjs --print-args   打印将执行的 wrangler 参数（JSON）后退出
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lifecycleAddArgs, missingLifecycleRules, parseJsonc, parseLifecycleRuleIds } from "./setup.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 部署页经 .dev.vars.example 以 secret 收集；生产由 scripts/deploy.mjs 以 --var 注入。 */
export const SECRET_VARS = ["TRANSCRIPTION_SERVICE_URL", "TRANSCRIPTION_PROVIDER", "GITHUB_OWNER", "GITHUB_REPO"];

export function communityConfig(source) {
  const config = parseJsonc(source);
  config.workers_dev = true;
  config.keep_vars = true;
  for (const name of SECRET_VARS) delete config.vars[name];
  config.vars.R2_BUCKET_NAME = config.r2_buckets[0].bucket_name;
  config.workflows[0].name = `${config.name}-processing`;
  return config;
}

export function communityDeploySteps(argv = [], databaseExists = true) {
  const deploy = ["deploy", ...argv.filter(arg => arg !== "--print-args")];
  if (argv.includes("--dry-run")) return [deploy];
  const migrate = ["d1", "migrations", "apply", "DB", "--remote"];
  return databaseExists ? [migrate, deploy] : [deploy, migrate];
}

function wrangler(args, configFile, stdout = "inherit") {
  return spawnSync("npx", ["wrangler", ...args, "--config", configFile], {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["ignore", stdout, stdout === "inherit" ? "inherit" : "pipe"],
    shell: process.platform === "win32",
  });
}

function ensureLifecycleRules(bucket, configFile) {
  const listed = wrangler(["r2", "bucket", "lifecycle", "list", bucket], configFile, "pipe");
  const missing = listed.status === 0 ? missingLifecycleRules(parseLifecycleRuleIds(listed.stdout)) : null;
  const added = (missing ?? []).every(rule => wrangler(lifecycleAddArgs(bucket, rule), configFile).status === 0);
  if (!missing || !added) {
    console.warn("⚠ Could not configure R2 lifecycle rules; add them manually (docs/DEPLOYMENT.md, R2 and lifecycle rules).");
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--print-args")) return console.log(JSON.stringify(communityDeploySteps(argv)));
  if (existsSync(join(ROOT, ".deploy.env")) || process.env.READ_PODCAST_DOMAIN) {
    throw new Error("Maintainer deployment values detected; use npm run deploy:production");
  }

  const config = communityConfig(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
  // 同目录临时文件：assets / migrations 等相对路径照常解析。
  const configFile = `.wrangler.community.${randomUUID()}.json`;
  writeFileSync(join(ROOT, configFile), JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
  try {
    const dryRun = argv.includes("--dry-run");
    const databaseExists = dryRun || wrangler(["d1", "info", config.d1_databases[0].database_name], configFile, "pipe").status === 0;
    for (const args of communityDeploySteps(argv, databaseExists)) {
      const result = wrangler(args, configFile);
      if (result.status !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(" ")} failed (exit ${result.status ?? 1})`);
    }
    if (!dryRun) ensureLifecycleRules(config.r2_buckets[0].bucket_name, configFile);
  } finally {
    unlinkSync(join(ROOT, configFile));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
