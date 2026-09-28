/**
 * 控制面认证守卫（HTTP Basic Auth）：
 * 保护 /manage* 与 /api/control/*，确保在 workers.dev 或未配置 Cloudflare Access 时控制面安全。
 * 公共浏览（/、/api/public/*、静态资源）不受影响，保持公开。
 */

/**
 * 判断给定路径是否属于受保护的控制面路径。
 */
export function isControlPath(path: string): boolean {
  return path.startsWith("/manage") || path === "/api/control" || path.startsWith("/api/control/");
}

/**
 * 解析 Authorization: Basic 请求头。
 * 兼容 Node Buffer 与标准 Web API（atob / TextDecoder），支持 UTF-8 编码凭据。
 */
export function parseBasicAuthHeader(header: string | null): { user: string; pass: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const base64 = header.slice(6).trim();
    if (!base64) return null;
    let raw: string;
    if (typeof Buffer !== "undefined") {
      raw = Buffer.from(base64, "base64").toString("utf-8");
    } else {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      raw = new TextDecoder().decode(bytes);
    }
    const colon = raw.indexOf(":");
    if (colon === -1) return null;
    return {
      user: raw.slice(0, colon),
      pass: raw.slice(colon + 1),
    };
  } catch {
    return null;
  }
}

/**
 * 常量时间字符串比对，防止时序攻击。
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.byteLength; i++) {
    diff |= aBuf[i] ^ bBuf[i];
  }
  return diff === 0;
}

export interface ControlAuthEnv {
  CONTROL_AUTH_USER?: string;
  CONTROL_AUTH_PASSWORD?: string;
  CONTROL_AUTH_MODE?: "access" | "local";
}

export interface ControlAuthCheckResult {
  authorized: boolean;
  response?: Response;
}

/**
 * 校验控制面访问权限：
 * 1. 非控制面路径直接放行；
 * 2. 凭据配置不全（只配了 user 或只配了 password）-> fail closed (401)；
 * 3. workers.dev 域名未配置凭据 -> fail closed (401)，杜绝控制面在 workers.dev 裸露；
 * 4. 配置了凭据 -> 校验 Authorization: Basic 凭据，不匹配返回 401；
 * 5. 自定义域名且未配置 Basic Auth -> 由外部 Cloudflare Access 在边缘拦截；请求到达 Worker 视为已由 Access 授权放行。
 */
export function checkControlAuth(
  request: Request,
  env: ControlAuthEnv,
): ControlAuthCheckResult {
  const url = new URL(request.url);
  if (!isControlPath(url.pathname)) {
    return { authorized: true };
  }

  const authUser = env.CONTROL_AUTH_USER?.trim();
  const authPass = env.CONTROL_AUTH_PASSWORD?.trim();
  const hasUser = Boolean(authUser);
  const hasPass = Boolean(authPass);
  const isWorkersDev = url.hostname.endsWith(".workers.dev");

  // 1. 凭据配置残缺（只设了一半）：fail closed
  if ((hasUser && !hasPass) || (!hasUser && hasPass)) {
    return {
      authorized: false,
      response: new Response(
        JSON.stringify({
          error: {
            code: "unauthorized",
            message: "Control plane authentication is misconfigured: both CONTROL_AUTH_USER and CONTROL_AUTH_PASSWORD are required",
          },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": 'Basic realm="Read Podcast Control"',
          },
        },
      ),
    };
  }

  // 2. Only the explicitly configured production Access path or the Node runtime
  // may delegate authentication. Workers.dev is never exempt, even on a production Worker.
  if (!hasUser && !hasPass && (isWorkersDev || (env.CONTROL_AUTH_MODE !== "access" && env.CONTROL_AUTH_MODE !== "local"))) {
    return {
      authorized: false,
      response: new Response(
        JSON.stringify({
          error: {
            code: "unauthorized",
            message: "Control plane requires Basic Auth credentials or an explicit external authentication mode",
          },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": 'Basic realm="Read Podcast Control"',
          },
        },
      ),
    };
  }

  // 3. 配置了凭据：校验 Basic Auth
  if (hasUser && hasPass) {
    const authHeader = request.headers.get("authorization");
    const credentials = parseBasicAuthHeader(authHeader);
    if (
      credentials &&
      timingSafeEqualString(credentials.user, authUser!) &&
      timingSafeEqualString(credentials.pass, authPass!)
    ) {
      return { authorized: true };
    }

    return {
      authorized: false,
      response: new Response(
        JSON.stringify({
          error: {
            code: "unauthorized",
            message: "Authentication required",
          },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": 'Basic realm="Read Podcast Control"',
          },
        },
      ),
    };
  }

  // 4. Explicitly configured custom-domain Access or local Node runtime.
  return { authorized: true };
}
