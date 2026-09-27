/**
 * Edge 精修客户端（行为迁移自 mac_worker/core/refiner.py）。
 *
 * 保留的真实生产行为：
 * - OpenAI 兼容 /chat/completions；model / temperature / max_tokens 严格取自配置快照；
 * - system: “你是一位专业的播客文字整理者。严格按照用户指令处理文本。”；
 * - extract_markdown() 代码围栏抽取；
 * - deepseek v4 / reasoner → thinking.type = "disabled"；
 * - OpenCode API → x-opencode-session: <random UUID>；
 * - 错误分类：429 / 5xx / 超时 / 连接错误 → 可重试；400 / 401 / 403 / 配置缺失 → 不可重试。
 *
 * 重试不再使用进程内 sleep 循环，交由 Workflow step 的 native retries 承载。
 */
import {
  DEFAULT_REFINE_PROMPT,
  DEFAULT_REFINE_PROMPT_EN,
  FALLBACK_REFINE_PROMPT,
  FALLBACK_REFINE_PROMPT_EN,
  REFINER_SYSTEM_PROMPT,
  REFINER_SYSTEM_PROMPT_EN,
} from "./defaults";

export type RefinerErrorCode = "refine_provider_auth" | "refine_provider_bad_request" | "refine_api_failed";

export class RefinerError extends Error {
  readonly code: RefinerErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    code: RefinerErrorCode,
    message: string,
    options: { retryable: boolean; status?: number; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "RefinerError";
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface RefinerConfigSnapshot {
  apiBase: string;
  model: string;
  temperature: number;
  maxTokens: number;
  minOutputRatio: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequestOptions {
  model: string;
  apiKey: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  apiBase: string;
  sessionId?: string;
}

export interface ChatResult {
  content: string;
  finishReason: string;
}

/** 抽取 Markdown 代码围栏内容（与 Python extract_markdown 行为一致）。 */
export function extractMarkdown(text: string): string {
  const patterns = [/```markdown\s*([\s\S]*?)\s*```/g, /```\s*([\s\S]*?)\s*```/g];
  for (const pattern of patterns) {
    const matches = [...String(text ?? "").matchAll(pattern)];
    if (matches.length) return matches.map(match => match[1].trim()).join("\n\n");
  }
  return String(text ?? "").trim();
}

/** deepseek v4 / reasoner 需要显式关闭 thinking，避免推理模式拖慢/截断成稿。 */
export function isReasoningModel(model: string): boolean {
  const value = (model ?? "").toLowerCase();
  return value.includes("deepseek") && (value.includes("v4") || value.includes("reasoner"));
}

/** OpenCode 网关要求会话路由头。 */
export function usesOpencodeSession(apiBase: string): boolean {
  return (apiBase ?? "").toLowerCase().includes("opencode");
}

export function buildChatRequest(options: ChatRequestOptions): { headers: Record<string, string>; body: Record<string, unknown> } {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.apiKey}`,
  };
  if (usesOpencodeSession(options.apiBase)) {
    headers["x-opencode-session"] = options.sessionId ?? crypto.randomUUID();
  }
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    max_tokens: Math.trunc(options.maxTokens),
    temperature: Number(options.temperature),
  };
  if (isReasoningModel(options.model)) body.thinking = { type: "disabled" };
  return { headers, body };
}

/** 组合精修 Prompt：任务级 custom_prompt 优先，否则使用默认杂志级 Prompt。 */
export function buildRefinePrompt(summary: string, customPrompt?: string | null, template = DEFAULT_REFINE_PROMPT): string {
  const isEn = template === DEFAULT_REFINE_PROMPT_EN;
  const effectiveSummary = summary || (isEn ? "No official show notes" : "无官方简介");
  const custom = (customPrompt ?? "").trim();
  if (custom) {
    return custom.includes("{summary}") ? custom.replaceAll("{summary}", effectiveSummary) : custom;
  }
  const base = (template ?? "").trim() || (isEn ? FALLBACK_REFINE_PROMPT_EN : FALLBACK_REFINE_PROMPT);
  return base.replaceAll("{summary}", effectiveSummary);
}

/** 精修消息体：system 固定角色 + user = `${prompt}\n\n${raw}`。 */
export function buildRefineMessages(prompt: string, rawText: string, systemPrompt = REFINER_SYSTEM_PROMPT): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${prompt}\n\n${rawText}` },
  ];
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? Math.min(seconds, 900) : undefined;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  const seconds = Math.round((when - Date.now()) / 1000);
  return seconds > 0 ? Math.min(seconds, 900) : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 通用 OpenAI 兼容 Chat Completions 调用（精修与概念提名共用）。
 * 所有失败统一抛 RefinerError，由调用方按 retryable 决定是否交给 Workflow 重试。
 */
export async function callChatCompletion(
  options: ChatRequestOptions & { timeoutMs?: number; fetchFn?: typeof fetch; signal?: AbortSignal },
): Promise<ChatResult> {
  const apiBase = (options.apiBase ?? "").trim().replace(/\/+$/, "");
  const model = (options.model ?? "").trim();
  if (!apiBase || !model) {
    throw new RefinerError("refine_provider_bad_request", "未配置精修服务商：api_base 与 model 必须齐全", { retryable: false });
  }
  if (!options.apiKey) {
    throw new RefinerError("refine_provider_auth", "缺少 REFINER_API_KEY（Wrangler Secret）", { retryable: false });
  }

  const fetchFn = options.fetchFn ?? fetch;
  const { headers, body } = buildChatRequest({ ...options, apiBase });
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 600_000);

  let response: Response;
  try {
    response = await fetchFn(`${apiBase}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    // 超时 / 连接错误 / DNS 失败 → durable retry
    throw new RefinerError("refine_api_failed", `精修请求失败: ${errorMessage(error)}`, { retryable: true });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const snippet = detail.slice(0, 200);
    if (response.status === 429) {
      throw new RefinerError("refine_api_failed", `精修服务商触发频率限制 (429)`, {
        retryable: true,
        status: 429,
        retryAfterSeconds: parseRetryAfter(response),
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new RefinerError("refine_provider_auth", `精修服务商鉴权失败 (HTTP ${response.status})`, {
        retryable: false,
        status: response.status,
      });
    }
    // 其余 4xx（400/404/422 等）视为请求本身有问题 → 不可重试
    if (response.status < 500 && response.status !== 408) {
      throw new RefinerError("refine_provider_bad_request", `精修请求失败 (HTTP ${response.status}): ${snippet}`, {
        retryable: false,
        status: response.status,
      });
    }
    // 408（请求超时）与 5xx → durable retry
    throw new RefinerError("refine_api_failed", `精修服务商返回 HTTP ${response.status}: ${snippet}`, {
      retryable: true,
      status: response.status,
      retryAfterSeconds: parseRetryAfter(response),
    });
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new RefinerError("refine_api_failed", `精修响应不是合法 JSON: ${errorMessage(error)}`, { retryable: true });
  }

  const choices = (data as { choices?: unknown })?.choices;
  const choice = Array.isArray(choices) && choices.length ? (choices[0] as Record<string, unknown>) : null;
  const message = choice && typeof choice === "object" ? (choice.message as Record<string, unknown> | undefined) : undefined;
  const rawContent = message && typeof message.content === "string" ? message.content : "";
  const content = rawContent.trim();
  const finishReason = typeof choice?.finish_reason === "string" ? (choice.finish_reason as string) : "stop";

  if (!content) {
    throw new RefinerError("refine_api_failed", "API 返回空内容", { retryable: true });
  }
  if (finishReason === "length") {
    console.warn("精修输出达到长度上限，可能被截断");
  }
  return { content, finishReason };
}

export interface RefinerClient {
  chat(messages: ChatMessage[], options?: { maxTokens?: number; temperature?: number; timeoutMs?: number }): Promise<ChatResult>;
}

/** 精修客户端：绑定一次配置快照（Workflow 创建时采样，任务中途不随配置漂移）。 */
export function createRefinerClient(args: {
  apiBase: string;
  model: string;
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  sessionId?: string;
}): RefinerClient {
  return {
    async chat(messages, options = {}) {
      return callChatCompletion({
        apiBase: args.apiBase,
        model: args.model,
        apiKey: args.apiKey,
        messages,
        maxTokens: options.maxTokens ?? args.maxTokens ?? 65536,
        temperature: options.temperature ?? args.temperature ?? 0.3,
        timeoutMs: options.timeoutMs ?? args.timeoutMs ?? 600_000,
        fetchFn: args.fetchFn,
        sessionId: args.sessionId,
      });
    },
  };
}
