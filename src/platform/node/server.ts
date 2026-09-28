import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { checkControlAuth } from "../../auth";
import worker from "../../index";
import { runMaintenance } from "../../tasks";
import { createNodeEnv, type NodeEnvOptions, type NodePlatformRuntime } from "./env";
import { cleanExpiredObjects, verifyStorageSignature } from "./storage";

export function loadDotEnv(envFilePath = ".env"): void {
  const fullPath = resolve(process.cwd(), envFilePath);
  if (!existsSync(fullPath)) return;
  const content = readFileSync(fullPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

export interface ServerOptions extends NodeEnvOptions {
  port?: number;
  host?: string;
  authUsername?: string;
  authPassword?: string;
}

export interface RunningServer {
  server: Server;
  runtime: NodePlatformRuntime;
  port: number;
  host: string;
  close: () => Promise<void>;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  loadDotEnv();

  const host = options.host || process.env.HOST || "127.0.0.1";
  const port = options.port || Number(process.env.PORT) || 3000;
  const authUser = options.authUsername || process.env.CONTROL_AUTH_USER || process.env.BASIC_AUTH_USER;
  const authPass = options.authPassword || process.env.CONTROL_AUTH_PASSWORD || process.env.BASIC_AUTH_PASSWORD;
  const storageDir = options.storageDir || process.env.STORAGE_PATH || "./data/storage";

  let actualPort = port;
  const runtime = createNodeEnv({
    ...options,
    baseUrl: options.baseUrl || (() => (process.env.APP_BASE_URL || (process.env.BASE_URL && process.env.BASE_URL.startsWith("http") ? process.env.BASE_URL : `http://${host}:${actualPort}`))),
    signingSecret: options.signingSecret || process.env.INTERNAL_SIGNING_SECRET,
    storageDir,
  });
  if (authUser) runtime.env.CONTROL_AUTH_USER = authUser;
  if (authPass) runtime.env.CONTROL_AUTH_PASSWORD = authPass;
  const signingSecret = runtime.signingSecret;

  // 恢复未完成的工作流
  await runtime.workflowEngine.resumeRunningWorkflows();

  // 周期性维护（每 5 分钟）：收敛未启动任务与僵尸任务，清理超期存储对象
  const maintenanceTimer = setInterval(async () => {
    try {
      await runMaintenance(runtime.env);
      await cleanExpiredObjects(storageDir);
    } catch (err) {
      console.error("Scheduled maintenance error:", err);
    }
  }, 5 * 60 * 1000);

  const requestListener = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host || `${host}:${port}`}`);

      // 1. 签名下载端点（供给转录容器或外部计算拉取上传的音频）
      if (url.pathname === "/storage/download") {
        const key = url.searchParams.get("key");
        const expires = Number(url.searchParams.get("expires"));
        const sig = url.searchParams.get("sig");

        if (!key || !expires || !sig || !verifyStorageSignature(key, expires, sig, signingSecret)) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: "forbidden", message: "Invalid or expired storage signature" } }));
          return;
        }

        const obj = await runtime.objectStore.get(key);
        if (!obj) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: "not_found", message: "Object not found" } }));
          return;
        }

        const rangeHeader = req.headers.range;
        if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
          const [rawStart, rawEnd] = rangeHeader.replace(/bytes=/, "").split("-");
          let start: number;
          let end: number;
          if (!rawStart) {
            // 后缀范围 bytes=-N：最后 N 个字节
            const suffix = rawEnd ? parseInt(rawEnd, 10) : 0;
            start = suffix > 0 ? Math.max(0, obj.size - suffix) : obj.size;
            end = obj.size - 1;
          } else {
            start = parseInt(rawStart, 10);
            // end 超出文件长度时按规范截断，否则 content-length 与实际字节数不符
            end = rawEnd ? Math.min(parseInt(rawEnd, 10), obj.size - 1) : obj.size - 1;
          }

          if (start >= obj.size || start > end) {
            res.statusCode = 416;
            res.setHeader("content-range", `bytes */${obj.size}`);
            res.end();
            return;
          }

          res.statusCode = 206;
          res.setHeader("content-type", "application/octet-stream");
          res.setHeader("content-range", `bytes ${start}-${end}/${obj.size}`);
          res.setHeader("content-length", String(end - start + 1));
          res.setHeader("accept-ranges", "bytes");

          if (obj.body) {
            let currentByte = 0;
            const reader = obj.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunkStart = currentByte;
              const chunkEnd = currentByte + value.length - 1;
              currentByte += value.length;

              if (chunkEnd < start || chunkStart > end) continue;

              const sliceStart = Math.max(0, start - chunkStart);
              const sliceEnd = Math.min(value.length, end - chunkStart + 1);
              res.write(value.subarray(sliceStart, sliceEnd));
            }
          }
          res.end();
          return;
        }

        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("content-length", String(obj.size));
        res.setHeader("accept-ranges", "bytes");

        if (obj.body) {
          const reader = obj.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        res.end();
        return;
      }

      // 2. 控制面访问认证（Basic Auth）：保护 /manage* 与 /api/control/*，公共面保持公开
      const dummyReq = new Request(url.toString(), {
        method: req.method,
        headers: new Headers(req.headers as Record<string, string>),
      });
      const auth = checkControlAuth(dummyReq, runtime.env);
      if (!auth.authorized) {
        const resp = auth.response!;
        res.statusCode = resp.status;
        resp.headers.forEach((val, key) => res.setHeader(key, val));
        res.end(await resp.text());
        return;
      }

      // 3. 构造 Web 标准 Request 并委托给通用 Worker 处理
      const headers = new Headers();
      for (const [headerName, headerVal] of Object.entries(req.headers)) {
        if (headerVal === undefined) continue;
        if (Array.isArray(headerVal)) {
          for (const v of headerVal) headers.append(headerName, v);
        } else {
          headers.set(headerName, headerVal);
        }
      }

      const body = req.method !== "GET" && req.method !== "HEAD" ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : null;
      const webReq = new Request(url.toString(), {
        method: req.method,
        headers,
        body,
        // @ts-ignore
        duplex: "half",
      });

      const backgroundTasks: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => {
          backgroundTasks.push(p);
          p.catch(err => console.error("Background task error:", err));
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;

      const webRes = await worker.fetch(webReq, runtime.env, ctx);

      res.statusCode = webRes.status;
      webRes.headers.forEach((val, k) => {
        res.setHeader(k, val);
      });

      if (webRes.body) {
        const reader = webRes.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (serverErr) {
      console.error("Server unhandled error:", serverErr);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { code: "internal_error", message: "Internal server error" } }));
      }
    }
  };

  const server = createServer(requestListener);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.listen(port, host, () => resolvePromise());
    server.on("error", rejectPromise);
  });

  const address = server.address();
  if (typeof address === "object" && address) {
    actualPort = address.port;
  }

  return {
    server,
    runtime,
    port: actualPort,
    host,
    close: async () => {
      clearInterval(maintenanceTimer);
      if (typeof (server as any).closeAllConnections === "function") {
        (server as any).closeAllConnections();
      }
      await new Promise<void>((res, rej) => {
        server.close(err => (err ? rej(err) : res()));
      });
      runtime.close();
    },
  };
}

// 直接运行此文件时启动服务器
const isDirectRun = process.argv[1] && (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"));
if (isDirectRun) {
  startServer()
    .then(({ host, port }) => {
      console.log(`Read Podcast server listening on http://${host}:${port}`);
    })
    .catch(err => {
      console.error("Failed to start server:", err);
      process.exit(1);
    });
}
