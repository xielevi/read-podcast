import { defineConfig } from "vitest/config";

// Worker 运行时专属模块（cloudflare:workers / cloudflare:workflows）在 Node 测试环境中不存在，
// 统一映射到 test/shims/ 下的最小等价实现；生产代码保持标准 import 不变。
const shim = (name: string) => new URL(`./test/shims/${name}`, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": shim("cloudflare-workers.ts"),
      "cloudflare:workflows": shim("cloudflare-workflows.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
