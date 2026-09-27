export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "content_type", "Content-Type must be application/json");
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

/** 分页 limit：缺省或非数字取 fallback，并夹在 [1, max]。 */
export function parseLimit(url: URL, fallback: number, max: number): number {
  const value = Number(url.searchParams.get("limit") ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(1, Math.trunc(value))) : fallback;
}

/** 分页 offset：缺省或非数字取 0，负数夹到 0。 */
export function parseOffset(url: URL): number {
  const value = Number(url.searchParams.get("offset") ?? 0);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function bearerMatches(request: Request, expected: string): boolean {
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}
