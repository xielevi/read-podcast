/**
 * 控制面认证守卫与生产边界测试：
 * 1. 路径守卫（isControlPath）；
 * 2. Basic Auth 凭据解析与常量时间比较；
 * 3. 静态资源（/manage*）在未提供有效凭据时不得返回 200 / 不得吐出 SPA 静态资产；
 * 4. 缺失凭据 fail closed（缺少请求头、错误密码、环境变量残缺、workers.dev 无凭据）；
 * 5. 公共面边界（/、/app.js、/api/public/*）保持公开直达（200）；
 * 6. 生产边界守卫（workers_dev=false、run_worker_first 包含 /manage*、Deploy Button 绑定描述完整）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { checkControlAuth, isControlPath, parseBasicAuthHeader, timingSafeEqualString } from "../src/auth";
import { makeCloud } from "./helpers/cloud";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf-8");

describe("isControlPath", () => {
  it("识别控制面路径", () => {
    expect(isControlPath("/manage")).toBe(true);
    expect(isControlPath("/manage/")).toBe(true);
    expect(isControlPath("/manage/settings")).toBe(true);
    expect(isControlPath("/manage/tasks/123")).toBe(true);
    expect(isControlPath("/api/control")).toBe(true);
    expect(isControlPath("/api/control/")).toBe(true);
    expect(isControlPath("/api/control/tasks")).toBe(true);
    expect(isControlPath("/api/control/settings")).toBe(true);
  });

  it("非控制面路径判定为 false", () => {
    expect(isControlPath("/")).toBe(false);
    expect(isControlPath("/index.html")).toBe(false);
    expect(isControlPath("/app.js")).toBe(false);
    expect(isControlPath("/app.css")).toBe(false);
    expect(isControlPath("/js/app.js")).toBe(false);
    expect(isControlPath("/api/public/health")).toBe(false);
    expect(isControlPath("/api/public/articles")).toBe(false);
    expect(isControlPath("/manager")).toBe(true);
    expect(isControlPath("/management")).toBe(true);
  });
});

describe("Basic Auth 解析与常量时间比对", () => {
  it("解析合法的 Basic Auth 头部（含包含冒号的密码与 UTF-8 凭据）", () => {
    const creds1 = parseBasicAuthHeader(`Basic ${btoa("admin:secret123")}`);
    expect(creds1).toEqual({ user: "admin", pass: "secret123" });

    const creds2 = parseBasicAuthHeader(`Basic ${btoa("admin:p:a:s:s:word")}`);
    expect(creds2).toEqual({ user: "admin", pass: "p:a:s:s:word" });

    const creds3 = parseBasicAuthHeader(`Basic ${Buffer.from("用户:密码123").toString("base64")}`);
    expect(creds3).toEqual({ user: "用户", pass: "密码123" });
  });

  it("格式非法或非 Basic 头部返回 null", () => {
    expect(parseBasicAuthHeader(null)).toBeNull();
    expect(parseBasicAuthHeader("")).toBeNull();
    expect(parseBasicAuthHeader("Bearer token123")).toBeNull();
    expect(parseBasicAuthHeader("Basic ")).toBeNull();
    expect(parseBasicAuthHeader("Basic invalid-base64!!")).toBeNull();
    expect(parseBasicAuthHeader(`Basic ${btoa("no-colon")}`)).toBeNull();
  });

  it("timingSafeEqualString 常量时间比对", () => {
    expect(timingSafeEqualString("hello", "hello")).toBe(true);
    expect(timingSafeEqualString("hello", "world")).toBe(false);
    expect(timingSafeEqualString("hello", "hell")).toBe(false);
    expect(timingSafeEqualString("hello", "hello world")).toBe(false);
    expect(timingSafeEqualString("", "")).toBe(true);
  });
});

describe("控制面认证守卫与 fail closed 机制", () => {
  it("非控制面路径无需认证放行", () => {
    const req = new Request("https://edge.test/api/public/health");
    const result = checkControlAuth(req, { CONTROL_AUTH_USER: "admin", CONTROL_AUTH_PASSWORD: "password" });
    expect(result.authorized).toBe(true);
    expect(result.response).toBeUndefined();
  });

  it("凭据配置不全时 fail closed（返回 401）", async () => {
    const req = new Request("https://edge.test/manage");

    // 只有 user 没有 password
    const resUserOnly = checkControlAuth(req, { CONTROL_AUTH_USER: "admin", CONTROL_AUTH_PASSWORD: "" });
    expect(resUserOnly.authorized).toBe(false);
    expect(resUserOnly.response?.status).toBe(401);
    expect(resUserOnly.response?.headers.get("www-authenticate")).toContain("Basic");
    const jsonUser = (await resUserOnly.response?.json()) as { error: { code: string } };
    expect(jsonUser.error.code).toBe("unauthorized");

    // 只有 password 没有 user
    const resPassOnly = checkControlAuth(req, { CONTROL_AUTH_USER: "", CONTROL_AUTH_PASSWORD: "secret" });
    expect(resPassOnly.authorized).toBe(false);
    expect(resPassOnly.response?.status).toBe(401);
  });

  it("workers.dev 上未配置凭据时必须 fail closed（返回 401），绝不匿名 200", async () => {
    const reqManage = new Request("https://podcast.user.workers.dev/manage");
    const resManage = checkControlAuth(reqManage, {});
    expect(resManage.authorized).toBe(false);
    expect(resManage.response?.status).toBe(401);
    expect(resManage.response?.headers.get("www-authenticate")).toContain("Basic");

    const reqApi = new Request("https://podcast.user.workers.dev/api/control/tasks");
    const resApi = checkControlAuth(reqApi, {});
    expect(resApi.authorized).toBe(false);
    expect(resApi.response?.status).toBe(401);
    expect(checkControlAuth(reqManage, { CONTROL_AUTH_MODE: "access" }).response?.status).toBe(401);
  });

  it("custom domain without explicit Access mode also fails closed", () => {
    const req = new Request("https://podcast.example.org/manage");
    expect(checkControlAuth(req, {}).response?.status).toBe(401);
    expect(checkControlAuth(req, { CONTROL_AUTH_MODE: "access" }).authorized).toBe(true);
  });

  it("配置了凭据时，未携带或携带错误凭据均被拒绝（401）", () => {
    const env = { CONTROL_AUTH_USER: "admin", CONTROL_AUTH_PASSWORD: "correct-password" };

    // 无头
    const reqNoHeader = new Request("https://edge.test/manage");
    expect(checkControlAuth(reqNoHeader, env).authorized).toBe(false);

    // 错误密码
    const reqWrongPass = new Request("https://edge.test/manage", {
      headers: { authorization: `Basic ${btoa("admin:wrong")}` },
    });
    expect(checkControlAuth(reqWrongPass, env).authorized).toBe(false);

    // 错误用户名
    const reqWrongUser = new Request("https://edge.test/manage", {
      headers: { authorization: `Basic ${btoa("user:correct-password")}` },
    });
    expect(checkControlAuth(reqWrongUser, env).authorized).toBe(false);

    // 正确凭据
    const reqOk = new Request("https://edge.test/manage", {
      headers: { authorization: `Basic ${btoa("admin:correct-password")}` },
    });
    expect(checkControlAuth(reqOk, env).authorized).toBe(true);
  });
});

describe("端到端 Worker 路由与静态资产守卫", () => {
  it("静态资产 /manage* 在未提供 Basic Auth 凭据时返回 401，资产 handler 不被调用", async () => {
    const cloud = makeCloud();
    cloud.env.CONTROL_AUTH_USER = "admin";
    cloud.env.CONTROL_AUTH_PASSWORD = "secret-password";

    let assetCalled = false;
    cloud.env.assets = {
      fetch: async () => {
        assetCalled = true;
        return new Response("<html>SPA</html>", { status: 200, headers: { "content-type": "text/html" } });
      },
    };

    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

    // 1. 匿名访问 /manage -> 401，不执行 asset handler
    const unauthed = await worker.fetch(new Request("https://edge.test/manage"), cloud.env, ctx);
    expect(unauthed.status).toBe(401);
    expect(unauthed.headers.get("www-authenticate")).toContain("Basic");
    expect(assetCalled).toBe(false);

    // 2. 匿名访问 /manage/settings -> 401
    const unauthedSub = await worker.fetch(new Request("https://edge.test/manage/settings"), cloud.env, ctx);
    expect(unauthedSub.status).toBe(401);
    expect(assetCalled).toBe(false);

    // 3. 携带正确凭据访问 /manage -> 200，正常输出 SPA
    const authed = await worker.fetch(
      new Request("https://edge.test/manage", {
        headers: { authorization: `Basic ${btoa("admin:secret-password")}` },
      }),
      cloud.env,
      ctx,
    );
    expect(authed.status).toBe(200);
    expect(assetCalled).toBe(true);
    expect(await authed.text()).toBe("<html>SPA</html>");
  });

  it("控制面 API 在未授权时返回 401，授权后返回 200", async () => {
    const cloud = makeCloud();
    cloud.env.CONTROL_AUTH_USER = "admin";
    cloud.env.CONTROL_AUTH_PASSWORD = "secret-password";
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

    // 匿名调用控制面任务接口 -> 401
    const denied = await worker.fetch(new Request("https://edge.test/api/control/tasks"), cloud.env, ctx);
    expect(denied.status).toBe(401);

    // 认证后调用 -> 200
    const allowed = await worker.fetch(
      new Request("https://edge.test/api/control/tasks", {
        headers: { authorization: `Basic ${btoa("admin:secret-password")}` },
      }),
      cloud.env,
      ctx,
    );
    expect(allowed.status).toBe(200);
  });

  it("公共浏览路径（/、/app.js、/api/public/*）保持公开匿名 200", async () => {
    const cloud = makeCloud();
    cloud.env.CONTROL_AUTH_USER = "admin";
    cloud.env.CONTROL_AUTH_PASSWORD = "secret-password";
    cloud.env.assets = {
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        return new Response(`asset:${path}`, { status: 200 });
      },
    };
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

    // 公开面 API
    const health = await worker.fetch(new Request("https://edge.test/api/public/health"), cloud.env, ctx);
    expect(health.status).toBe(200);

    const articles = await worker.fetch(new Request("https://edge.test/api/public/articles"), cloud.env, ctx);
    expect(articles.status).toBe(200);

    // 公开静态页面与脚本
    const root = await worker.fetch(new Request("https://edge.test/"), cloud.env, ctx);
    expect(root.status).toBe(200);
    expect(await root.text()).toBe("asset:/");

    const appJs = await worker.fetch(new Request("https://edge.test/app.js"), cloud.env, ctx);
    expect(appJs.status).toBe(200);
    expect(await appJs.text()).toBe("asset:/app.js");
  });
});

describe("生产边界与 Deploy Button 约定配置", () => {
  it("wrangler.jsonc 保持 workers_dev=false 与 preview_urls=false", () => {
    const config = read("wrangler.jsonc");
    expect(config).toContain('"workers_dev": false');
    expect(config).toContain('"preview_urls": false');
  });

  it("wrangler.jsonc 的 run_worker_first 包含 /manage*，避免静态资产绕过认证", () => {
    const config = read("wrangler.jsonc");
    expect(config).toMatch(/"run_worker_first"\s*:\s*\[\s*"\/api\/\*"\s*,\s*"\/manage\*"\s*\]/);
  });

  it("package.json 包含符合 Cloudflare Deploy Button 规范的 cloudflare.bindings 描述", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.cloudflare).toBeDefined();
    expect(pkg.cloudflare.bindings).toBeDefined();

    const bindings = pkg.cloudflare.bindings;

    // 核心云资源 binding
    expect(bindings.DB?.description).toBeDefined();
    expect(bindings.RAW_BUCKET?.description).toBeDefined();
    expect(bindings.PROCESSING_WORKFLOW?.description).toBeDefined();

    // 必需凭据
    expect(bindings.CONTROL_AUTH_USER?.description).toBeDefined();
    expect(bindings.CONTROL_AUTH_PASSWORD?.description).toBeDefined();
    expect(bindings.REFINER_API_KEY?.description).toBeDefined();
    expect(bindings.GITHUB_TOKEN?.description).toBeDefined();
    expect(bindings.GITHUB_OWNER?.description).toBeDefined();
    expect(bindings.GITHUB_REPO?.description).toBeDefined();

    // 可选/条件凭据
    expect(bindings.TRANSCRIPTION_PROVIDER?.description).toBeDefined();
    expect(bindings.TRANSCRIPTION_SERVICE_URL?.description).toBeDefined();
    expect(bindings.CF_ACCESS_CLIENT_ID?.description).toBeDefined();
    expect(bindings.CF_ACCESS_CLIENT_SECRET?.description).toBeDefined();
    expect(bindings.DASHSCOPE_API_KEY?.description).toBeDefined();
  });
});
