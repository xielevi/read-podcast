#!/usr/bin/env node
// 社区部署入口（npm run deploy）：Deploy to Cloudflare / Workers Builds 与命令行共用。
// 维护者 custom-domain + Access 生产发布用 npm run deploy:production（scripts/deploy.mjs）。
//
// 仓库里的 wrangler.jsonc 保持生产形态（workers_dev=false），也是 Deploy 按钮读取并改写的资源清单；
// cloudflare.config.ts 在 community 模式下用 communityConfig 派生：
// - 打开 workers.dev，控制面由 CONTROL_AUTH_* Basic Auth 守护（缺凭据 fail closed）；
// - 去掉部署页以 secret 收集的同名 vars（同名 plain var 与 secret 会被 Cloudflare 拒绝）；
// - Workflow 名跟随 Worker 名、R2_BUCKET_NAME 跟随 bucket_name：部署页改名或同账号多实例时不串用资源。
// cf deploy 保留 secrets，但没有 keep_vars：dashboard 上的部署者变量要设为 Secret 类型才能跨部署保留。
// 步骤：D1 remote 迁移与 cf deploy（首次部署由 cf 自动创建 D1/R2，此时先部署再迁移）
// → R2 生命周期规则（幂等；失败只告警）。
//
//   npm run deploy                     部署
//   npm run deploy -- --dry-run        只打包校验，不碰远端
//   node scripts/deploy_community.mjs --print-args   打印将执行的 cf 参数（JSON）后退出
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractJson, findDatabaseId, lifecycleUpdateArgs, missingLifecycleRules, parseJsonc, parseLifecycleRules, runCf } from "./setup.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const COMMUNITY_MODE = "community";

/** 部署页经 .dev.vars.example 以 secret 收集；生产由 scripts/deploy.mjs 注入。 */
export const SECRET_VARS = ["TRANSCRIPTION_SERVICE_URL", "TRANSCRIPTION_PROVIDER", "GITHUB_OWNER", "GITHUB_REPO"];

export function communityConfig(source) {
  const config = parseJsonc(source);
  config.workers_dev = true;
  for (const name of SECRET_VARS) delete config.vars[name];
  config.vars.R2_BUCKET_NAME = config.r2_buckets[0].bucket_name;
  config.workflows[0].name = `${config.name}-processing`;
  return config;
}

/** databaseId 为空表示库尚不存在或 dry-run：此时不在部署前迁移。 */
export function communityDeploySteps(argv = [], databaseId = null) {
  const deploy = ["deploy", "--mode", COMMUNITY_MODE, ...argv.filter(arg => arg !== "--print-args")];
  if (argv.includes("--dry-run") || !databaseId) return [deploy];
  return [["d1", "migrations", "apply", databaseId], deploy];
}

function run(args) {
  const result = runCf(args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`cf ${args.slice(0, 2).join(" ")} failed (exit ${result.status})`);
}

function databaseIdByName(name) {
  const listed = runCf(["d1", "list", "--name", name]);
  if (listed.status !== 0) throw new Error(`cf d1 list failed (exit ${listed.status}): ${listed.stderr}`);
  return findDatabaseId(extractJson(listed.stdout), name);
}

function ensureLifecycleRules(bucket) {
  const listed = runCf(["r2", "buckets", "lifecycle", "get", bucket]);
  const existing = listed.status === 0 ? parseLifecycleRules(listed.stdout) : null;
  const missing = existing && missingLifecycleRules(existing.map(rule => rule.id));
  const updated = missing?.length ? runCf(lifecycleUpdateArgs(bucket, existing, missing)).status === 0 : Boolean(missing);
  if (!updated) console.warn("⚠ Could not configure R2 lifecycle rules; add them manually (docs/DEPLOYMENT.md, R2 and lifecycle rules).");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--print-args")) return console.log(JSON.stringify(communityDeploySteps(argv)));
  if (existsSync(join(ROOT, ".deploy.env")) || process.env.READ_PODCAST_DOMAIN) {
    throw new Error("Maintainer deployment values detected; use npm run deploy:production");
  }

  const config = communityConfig(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
  const dryRun = argv.includes("--dry-run");
  const databaseName = config.d1_databases[0].database_name;
  const databaseId = dryRun ? null : databaseIdByName(databaseName);
  for (const args of communityDeploySteps(argv, databaseId)) run(args);
  if (dryRun) return;
  if (!databaseId) {
    const created = databaseIdByName(databaseName);
    if (!created) throw new Error(`D1 database ${databaseName} was not created by cf deploy`);
    run(["d1", "migrations", "apply", created]);
  }
  ensureLifecycleRules(config.r2_buckets[0].bucket_name);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
