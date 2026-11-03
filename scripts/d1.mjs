#!/usr/bin/env node
// cf 的 D1 命令只接受数据库 ID：这里按 wrangler.jsonc 的 database_name 解析 ID，再执行迁移或只读查询。
// 本地开发库用 cloudflare.config.ts 在 development 模式声明的固定 ID，数据与 cf dev 共用 .cloudflare/state。
//
//   node scripts/d1.mjs migrate --remote|--local
//   node scripts/d1.mjs query --remote|--local "<sql>"     输出行对象 JSON 数组
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractJson, findDatabaseId, parseJsonc, resourcesFromConfig, runCf } from "./setup.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const LOCAL_DATABASE_ID = "00000000-0000-4000-8000-000000000001";
export const LOCAL_STATE_ARGS = ["--local", "--persist-to", ".cloudflare/state"];

/** `cf d1 raw` 每条语句返回 { results: { columns, rows } }；还原为行对象。 */
export function rowsFromRaw(text) {
  const results = extractJson(text)?.[0]?.results;
  if (!Array.isArray(results?.columns) || !Array.isArray(results?.rows)) throw new Error("could not parse `cf d1 raw` output");
  return results.rows.map(row => Object.fromEntries(results.columns.map((column, index) => [column, row[index]])));
}

function checked(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status}): ${result.stderr || result.stdout}`.trim());
  return result;
}

function target(local) {
  if (local) return { id: LOCAL_DATABASE_ID, flags: LOCAL_STATE_ARGS };
  const { d1DatabaseName: name } = resourcesFromConfig(parseJsonc(readFileSync(`${ROOT}/wrangler.jsonc`, "utf-8")));
  const listed = checked(runCf(["d1", "list", "--name", name]), "cf d1 list");
  const id = findDatabaseId(extractJson(listed.stdout), name);
  if (!id) throw new Error(`D1 database ${name} not found; run npm run setup -- --step d1`);
  return { id, flags: [] };
}

function main() {
  const [command, location, sql] = process.argv.slice(2);
  if (!["migrate", "query"].includes(command) || !["--remote", "--local"].includes(location) || (command === "query" && !sql)) {
    throw new Error('Usage: node scripts/d1.mjs migrate --remote|--local | query --remote|--local "<sql>"');
  }
  const { id, flags } = target(location === "--local");
  if (command === "migrate") {
    console.log(checked(runCf(["d1", "migrations", "apply", id, ...flags]), "cf d1 migrations apply").stdout.trim());
    return;
  }
  console.log(JSON.stringify(rowsFromRaw(checked(runCf(["d1", "raw", id, ...flags, "--sql", sql]), "cf d1 raw").stdout)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
