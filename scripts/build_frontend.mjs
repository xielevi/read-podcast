#!/usr/bin/env node
// 把 public/js/NN-*.js 按文件名顺序逐字节拼成运行时加载的 public/app.js（生成物，不入库）。
// wrangler.jsonc 的 build.command 在 deploy / dev / dry-run 前调用；Docker 由 npm run build:server 调用；
// 测试直接用 assembleFrontend()。'use strict' 只由 bundle 第一行提供：指令只在脚本开头生效，
// 写在分片里会随拼接落到中间而静默失效，因此分片中一律禁止。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FRAGMENTS = new URL("../public/js/", import.meta.url);

export function assembleFrontend() {
  const names = readdirSync(FRAGMENTS).filter(name => name.endsWith(".js")).sort();
  const sources = names.map(name => readFileSync(new URL(name, FRAGMENTS), "utf8"));
  const strict = names.find((_, i) => /^\s*['"]use strict['"];?\s*$/m.test(sources[i]));
  if (strict) throw new Error(`public/js/${strict}: 'use strict' may only appear at the top of the bundle`);
  return `'use strict';\n${sources.join("")}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("../public/app.js", import.meta.url), assembleFrontend());
}
