#!/usr/bin/env node
// 社区通用部署入口（npm run deploy）：供 Cloudflare Builds / Deploy Button 与社区用户调用。
//
// 1. 自动执行 D1 remote 迁移（按 wrangler.jsonc 中绑定的 DB 执行，安全幂等）；
// 2. 执行 wrangler deploy 发布 Worker。
// 3. 传入 --dry-run 时只执行 wrangler deploy --dry-run 校验，不触碰远程数据库。
//
// 维护者 custom-domain + Access 生产发布请使用 npm run deploy:production（scripts/deploy.mjs）。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export function communityConfigFrom(source) {
  const disabled = /"workers_dev"\s*:\s*false/;
  if (!disabled.test(source)) throw new Error("Expected workers_dev: false in production config");
  return source.replace(disabled, '"workers_dev": true');
}

/**
 * 根据传入参数构建部署执行计划。
 * 导出该纯函数供单元测试直接验证逻辑。
 */
export function buildCommunityDeploySteps(argv = []) {
  const isDryRun = argv.includes("--dry-run");
  const passthrough = argv.filter(arg => arg !== "--print-args");

  if (isDryRun) {
    return [
      {
        name: "deploy",
        command: "wrangler",
        args: ["deploy", ...passthrough],
      },
    ];
  }

  return [
    {
      name: "migrate",
      command: "wrangler",
      args: ["d1", "migrations", "apply", "DB", "--remote"],
    },
    {
      name: "deploy",
      command: "wrangler",
      args: ["deploy", ...passthrough],
    },
  ];
}

function main() {
  const argv = process.argv.slice(2);
  const printOnly = argv.includes("--print-args");

  const steps = buildCommunityDeploySteps(argv);

  if (printOnly) {
    console.log(JSON.stringify(steps));
    return;
  }

  // The checked-in config deliberately keeps workers.dev OFF for the maintainer's
  // Access-gated custom domain. A community deploy uses a temporary config in
  // the same directory (so relative assets/migrations paths still resolve).
  const sourceConfig = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  const communityConfig = `.wrangler.community.${randomUUID()}.jsonc`;
  const configPath = join(ROOT, communityConfig);
  writeFileSync(configPath, communityConfigFrom(sourceConfig), { flag: "wx", mode: 0o600 });

  try {
    const hasMaintainerConfig = existsSync(new URL("../.deploy.env", import.meta.url)) || Boolean(process.env.READ_PODCAST_DOMAIN);
    if (hasMaintainerConfig) throw new Error("Maintainer deployment values detected; use npm run deploy:production");
    for (const step of steps) {
      const args = [...step.args, "--config", communityConfig];
      console.log(`==> Running ${step.command} ${step.name}...`);
      const result = spawnSync("npx", [step.command, ...args], {
        cwd: ROOT,
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      if (result.status !== 0) {
        throw new Error(`Step "${step.name}" failed with exit code ${result.status ?? 1}`);
      }
    }
  } finally {
    unlinkSync(configPath);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
