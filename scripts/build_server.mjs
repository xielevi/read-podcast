import esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/platform/node/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/server.js",
  external: ["node:*"],
  alias: {
    "cloudflare:workers": resolve(process.cwd(), "test/shims/cloudflare-workers.ts"),
    "cloudflare:workflows": resolve(process.cwd(), "test/shims/cloudflare-workflows.ts"),
  },
  banner: {
    js: "// Read Podcast Node.js Server\n",
  },
});

console.log("Successfully built dist/server.js");
