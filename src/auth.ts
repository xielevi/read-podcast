/**
 * 控制面认证守卫：只管 /manage* 与 /api/control/*，公共浏览不受影响。
 * - 配置了 CONTROL_AUTH_USER + CONTROL_AUTH_PASSWORD：校验 HTTP Basic Auth；
 * - 未配置：只有显式 CONTROL_AUTH_MODE（access = 生产 custom domain 由 Cloudflare Access 在边缘鉴权；
 *   local = Docker / Node 本机）才放行，且 workers.dev 永不放行；其余一律 401（fail closed）。
 */
import { error } from "./http";

export interface ControlAuthEnv {
  CONTROL_AUTH_USER?: string;
  CONTROL_AUTH_PASSWORD?: string;
  CONTROL_AUTH_MODE?: "access" | "local";
}

export function isControlPath(path: string): boolean {
  return path.startsWith("/manage") || path === "/api/control" || path.startsWith("/api/control/");
}

/** UTF-8 Basic 凭据；格式不合法返回 null。 */
export function parseBasicAuthHeader(header: string | null): { user: string; pass: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const raw = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6).trim()), ch => ch.charCodeAt(0)));
    const colon = raw.indexOf(":");
    return colon === -1 ? null : { user: raw.slice(0, colon), pass: raw.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** 常量时间比较（长度不同直接 false）。 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)];
  return x.length === y.length && x.reduce((diff, byte, i) => diff | (byte ^ y[i]), 0) === 0;
}

function unauthorized(message: string): Response {
  const response = error(401, "unauthorized", message);
  response.headers.set("www-authenticate", 'Basic realm="Read Podcast Control"');
  return response;
}

/** 放行返回 null，拒绝返回 401 响应。 */
export function controlAuthFailure(request: Request, env: ControlAuthEnv): Response | null {
  const url = new URL(request.url);
  if (!isControlPath(url.pathname)) return null;
  const user = env.CONTROL_AUTH_USER?.trim();
  const pass = env.CONTROL_AUTH_PASSWORD?.trim();
  if (Boolean(user) !== Boolean(pass)) {
    return unauthorized("Control plane authentication is misconfigured: both CONTROL_AUTH_USER and CONTROL_AUTH_PASSWORD are required");
  }
  if (user && pass) {
    const credentials = parseBasicAuthHeader(request.headers.get("authorization"));
    const ok = credentials !== null && timingSafeEqualString(credentials.user, user) && timingSafeEqualString(credentials.pass, pass);
    return ok ? null : unauthorized("Authentication required");
  }
  const delegated = env.CONTROL_AUTH_MODE === "access" || env.CONTROL_AUTH_MODE === "local";
  if (delegated && !url.hostname.endsWith(".workers.dev")) return null;
  return unauthorized("Control plane requires Basic Auth credentials or an explicit external authentication mode");
}
