import { cloudflare } from "@cloudflare/vite-plugin";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const FRONTEND_SOURCE = resolve("public/js");

// public/app.js 是 public/js/ 分片的生成物（不入库）；Vite 不执行 Wrangler 的 build.command，这里接管。
function frontendBundle(): Plugin {
  const generate = () => execFileSync(process.execPath, ["scripts/build_frontend.mjs"], { stdio: "inherit" });
  return {
    name: "read-podcast:frontend-bundle",
    configResolved: generate,
    configureServer(server) {
      server.watcher.add(FRONTEND_SOURCE);
      server.watcher.on("change", file => {
        if (file.startsWith(FRONTEND_SOURCE)) generate();
      });
    },
  };
}

export default defineConfig({
  publicDir: "public",
  server: { port: 8787 },
  plugins: [frontendBundle(), cloudflare()],
});
