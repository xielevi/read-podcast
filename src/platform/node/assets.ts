/**
 * 本地静态资源服务：基于文件系统提供 public/ 目录下的静态文件与 SPA 路由兜底。
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface LocalAssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export function createLocalAssetFetcher(publicDir: string): LocalAssetFetcher {
  const root = resolve(publicDir);

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (!pathname || pathname === "/") pathname = "index.html";

      const targetPath = resolve(root, pathname);
      if (!targetPath.startsWith(root + sep) && targetPath !== root) {
        return new Response("Forbidden", { status: 403 });
      }

      if (existsSync(targetPath) && statSync(targetPath).isFile()) {
        const ext = extname(targetPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        const content = await readFile(targetPath);
        return new Response(content, {
          status: 200,
          headers: {
            "content-type": contentType,
            "cache-control": ext === ".html" ? "no-cache" : "public, max-age=86400",
          },
        });
      }

      // SPA 路由回退：对于无文件后缀的路径（例如 /manage），回退提供 index.html
      const hasExt = extname(pathname) !== "";
      if (!hasExt && existsSync(join(root, "index.html"))) {
        const content = await readFile(join(root, "index.html"));
        return new Response(content, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-cache",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}
