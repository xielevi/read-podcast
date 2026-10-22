/**
 * 稿件导读（Article Brief）：渐进式阅读的第一层——三分钟读完的 TL;DR / 要点 / 原话引用 /
 * 推荐读者，第二层是每节一句话的小结，第三层才是全文。
 *
 * 产品契约（见 docs/ARCHITECTURE.md「Article brief」）：
 * - 尽力而为：任何失败（服务商错误、非 JSON、校验不通过）→ brief = null，绝不阻塞发布；
 * - 代码拥有读者依赖的事实，不信任模型：reading_minutes 由稿件长度确定性计算；
 *   sections 的 heading 必须与稿件真实标题一致（回写为稿件原文）；quotes 必须逐字出现在稿件中；
 *   所有字段截断到上限；
 * - 输入受预算约束：超长稿件按节压缩（保留全部标题与每节开头），而不是只截前半篇。
 *
 * 纯函数 + 一次 Chat Completions 调用；不依赖 Workflow / D1 / R2。
 */
import { stripCodeFence } from "./concepts";
import { callChatCompletion, type RefinerConfigSnapshot } from "./refiner";
import type { ContentLanguage } from "../language";

export const BRIEF_VERSION = 1;

export interface BriefQuote {
  speaker: string;
  text: string;
}

export interface BriefSection {
  heading: string;
  summary: string;
}

export interface ArticleBrief {
  version: typeof BRIEF_VERSION;
  tldr: string;
  key_points: string[];
  quotes: BriefQuote[];
  audience: string;
  sections: BriefSection[];
  reading_minutes: number;
}

// ── 上限（字符） ──
export const BRIEF_LIMITS = {
  tldr: 400,
  keyPoint: 240,
  minKeyPoints: 3,
  maxKeyPoints: 6,
  quote: 300,
  speaker: 60,
  maxQuotes: 3,
  audience: 300,
  sectionSummary: 300,
  maxSections: 40,
} as const;

/** 送入模型的稿件预算（字符）。中文约 1 字 ≈ 1 token：典型 20–30k 字稿件全文送入，3 小时长稿按节压缩。 */
export const BRIEF_MAX_INPUT_CHARS = 48_000;
/** 导读输出的 token 上限：JSON 通常 < 2k token，留余量给小节较多的长稿。 */
export const BRIEF_MAX_OUTPUT_TOKENS = 4_000;
export const BRIEF_TEMPERATURE = 0.2;
/** 单次调用超时：导读不能把发布拖太久。 */
export const BRIEF_CALL_TIMEOUT_MS = 180_000;

/** 与前端 reader 统计口径一致：中文 750 字/分钟，西文 220 词/分钟。 */
const CJK_CHARS_PER_MINUTE = 750;
const WORDS_PER_MINUTE = 220;

export const BRIEF_SYSTEM_PROMPT =
  "你是一位资深杂志编辑，负责为一篇播客访谈整理稿撰写「导读」。只依据稿件内容，不补充外部知识，不加评价。只输出一个合法 JSON 对象，不要输出任何解释。";
export const BRIEF_SYSTEM_PROMPT_EN =
  "You are a senior magazine editor writing a reader's brief for an edited podcast interview. Use only the manuscript; add no outside knowledge or opinion. Output exactly one valid JSON object and nothing else.";

function briefInstructions(lang: ContentLanguage, headings: string[]): string {
  const headingList = headings.length ? headings.map(heading => `- ${heading}`).join("\n") : lang === "en" ? "(none)" : "（无）";
  if (lang === "en") {
    return `Write a brief for the manuscript below so a reader can decide in three minutes whether to read the full text.

Return JSON with exactly this shape:
{"version": 1, "tldr": string, "key_points": [string], "quotes": [{"speaker": string, "text": string}], "audience": string, "sections": [{"heading": string, "summary": string}]}

Rules:
- Write in English (the manuscript's language).
- tldr: 1–2 sentences stating what the episode is really about and its main conclusion.
- key_points: 3–6 concrete takeaways (claims, facts, arguments), one sentence each; no vague filler.
- quotes: 0–3 striking lines copied VERBATIM from the manuscript (exact characters, no paraphrase), with the speaker's name as labeled in the manuscript. Omit rather than paraphrase.
- audience: one sentence on who would benefit most from reading the full text.
- sections: one entry per section heading listed below, in order; "heading" must be copied exactly from the list; "summary" is 1–2 sentences on what that section adds.
- Do not include a reading time.

Section headings:
${headingList}

Manuscript:
"""
`;
  }
  return `请为下面这篇稿件撰写导读，让读者在三分钟内判断是否值得读全文。

返回且只返回如下结构的 JSON：
{"version": 1, "tldr": string, "key_points": [string], "quotes": [{"speaker": string, "text": string}], "audience": string, "sections": [{"heading": string, "summary": string}]}

要求：
- 使用中文（与稿件语言一致）。
- tldr：1–2 句话，说清这期节目真正在谈什么、核心结论是什么。
- key_points：3–6 条具体要点（观点、事实、论证），每条一句话，不要空泛套话。
- quotes：0–3 句最有力的原话，必须从稿件中逐字复制（一字不改，不得转述），speaker 为稿件中标注的说话人姓名。宁缺毋滥。
- audience：一句话说明什么样的读者最值得读全文。
- sections：按顺序为下列每个小节标题各写一条；heading 必须与列表中的标题完全一致；summary 用 1–2 句话说明该节的独特内容。
- 不要输出阅读时长。

小节标题：
${headingList}

稿件：
"""
`;
}

// ── 标题与正文工具 ──

const OUTLINE_HEADING = /^(?:(?:📌|⏱️|⏱|🕒)\s*)?(?:节目大纲与时间线|(?:Episode\s+)?Outline\s*(?:&|and)\s*Timeline|Timeline\s*(?:&|and)\s*Outline)\s*[:：]?$/iu;

/** 标题比较用的规范化：去 Markdown 强调符号、合并空白、小写。前端按同一规则匹配。 */
export function normalizeHeading(text: string): string {
  return String(text ?? "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function stripFrontmatter(markdown: string): string {
  return String(markdown ?? "").replace(/\r\n?/g, "\n").replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n*/, "");
}

/** 稿件中的小节标题（h1–h3，按出现顺序，去重，排除开头的大纲/时间线标题）。返回原文（去掉 # 与收尾 #）。 */
export function extractSectionHeadings(markdown: string): string[] {
  const headings: string[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const line of stripFrontmatter(markdown).split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].trim();
    const key = normalizeHeading(text);
    if (!key || OUTLINE_HEADING.test(text.replace(/[*_`]/g, "").trim()) || seen.has(key)) continue;
    seen.add(key);
    headings.push(text);
  }
  return headings;
}

/** 与前端阅读统计同一口径：字符集判定后，中文按非空白字符、西文按词计算分钟数（≥1）。 */
export function computeReadingMinutes(markdown: string): number {
  const clean = stripFrontmatter(markdown).trim();
  if (!clean) return 0;
  const sample = clean.slice(0, 20000);
  const cjk = (sample.match(/[一-龥㐀-䶿豈-﫿]/g) ?? []).length;
  const latin = (sample.match(/[a-zA-Z]/g) ?? []).length;
  const isCjk = cjk > 0 && cjk >= latin * 0.1;
  if (isCjk) return Math.max(1, Math.round(clean.replace(/\s+/g, "").length / CJK_CHARS_PER_MINUTE));
  return Math.max(1, Math.round(clean.split(/\s+/).filter(Boolean).length / WORDS_PER_MINUTE));
}

/**
 * 预算内压缩：未超预算原样返回；否则按小节切分，每节保留标题 + 开头若干字符（预算按节均分），
 * 保证后半篇的小节同样出现在模型输入里（小节摘要才有依据）。
 */
export function condenseForBrief(markdown: string, budget: number = BRIEF_MAX_INPUT_CHARS): string {
  const body = stripFrontmatter(markdown).trim();
  if (body.length <= budget) return body;

  const sections: string[] = [];
  let current: string[] = [];
  for (const line of body.split("\n")) {
    if (/^#{1,3}\s+/.test(line) && current.length) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) sections.push(current.join("\n"));

  const perSection = Math.max(200, Math.floor(budget / Math.max(1, sections.length)) - 4);
  const parts = sections.map(section => {
    if (section.length <= perSection) return section;
    const newline = section.indexOf("\n");
    const heading = /^#{1,3}\s+/.test(section) && newline > 0 ? section.slice(0, newline) : "";
    const rest = heading ? section.slice(newline + 1) : section;
    const keep = Math.max(0, perSection - heading.length - 3);
    return `${heading ? `${heading}\n` : ""}${rest.slice(0, keep).trimEnd()}\n…`;
  });
  const joined = parts.join("\n\n");
  return joined.length <= budget ? joined : joined.slice(0, budget);
}

/** 引用核验用的规范化：去强调符号、统一引号、合并空白。 */
function normalizeForQuote(text: string): string {
  return String(text ?? "")
    .replace(/[*_`]/g, "")
    .replace(/[“”«»「」『』]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** 从模型输出中取 JSON 对象：容忍代码围栏与前后多余文字；无法解析 → null。 */
export function parseBriefJson(content: string): unknown {
  const text = stripCodeFence(content);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * 校验并归一模型输出。不满足最低要求（缺 tldr 或要点不足 3 条）→ null；
 * 其余问题逐项修剪：标题对不上真实小节的 section、非逐字的引用被丢弃，超长截断，超量截取；
 * version 与 reading_minutes 由代码给出，不采信模型。
 */
export function normalizeBrief(raw: unknown, manuscript: string): ArticleBrief | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;

  const tldr = cleanText(input.tldr, BRIEF_LIMITS.tldr);
  const keyPoints = (Array.isArray(input.key_points) ? input.key_points : [])
    .map(point => cleanText(point, BRIEF_LIMITS.keyPoint))
    .filter(Boolean)
    .slice(0, BRIEF_LIMITS.maxKeyPoints);
  if (!tldr || keyPoints.length < BRIEF_LIMITS.minKeyPoints) return null;

  const haystack = normalizeForQuote(stripFrontmatter(manuscript));
  const quotes: BriefQuote[] = [];
  for (const item of Array.isArray(input.quotes) ? input.quotes : []) {
    if (quotes.length >= BRIEF_LIMITS.maxQuotes) break;
    if (!item || typeof item !== "object") continue;
    const quote = item as Record<string, unknown>;
    // 逐字核验：只接受未超长且在稿件中真实出现的原话（去掉首尾引号后比较）。
    const needle = normalizeForQuote(typeof quote.text === "string" ? quote.text : "").replace(/^["']+|["']+$/g, "").trim();
    if (needle.length < 4 || needle.length > BRIEF_LIMITS.quote || !haystack.includes(needle)) continue;
    quotes.push({ speaker: cleanText(quote.speaker, BRIEF_LIMITS.speaker), text: needle });
  }

  const headings = extractSectionHeadings(manuscript);
  const byKey = new Map(headings.map(heading => [normalizeHeading(heading), heading]));
  const order = new Map(headings.map((heading, index) => [heading, index]));
  const sections: BriefSection[] = [];
  const used = new Set<string>();
  for (const item of Array.isArray(input.sections) ? input.sections : []) {
    if (sections.length >= BRIEF_LIMITS.maxSections) break;
    if (!item || typeof item !== "object") continue;
    const section = item as Record<string, unknown>;
    const key = normalizeHeading(typeof section.heading === "string" ? section.heading.replace(/^#+\s*/, "") : "");
    const heading = byKey.get(key);
    const summary = cleanText(section.summary, BRIEF_LIMITS.sectionSummary);
    if (!heading || !summary || used.has(key)) continue;
    used.add(key);
    sections.push({ heading, summary });
  }
  // 按稿件顺序输出，与正文标题一一对应
  sections.sort((a, b) => (order.get(a.heading) ?? 0) - (order.get(b.heading) ?? 0));

  return {
    version: BRIEF_VERSION,
    tldr,
    key_points: keyPoints,
    quotes,
    audience: cleanText(input.audience, BRIEF_LIMITS.audience),
    sections,
    reading_minutes: computeReadingMinutes(manuscript),
  };
}

/**
 * API 读出：D1 中的 brief JSON → 对象；空 / 损坏 / 版本不认识 → null（旧稿件没有导读）。
 * 写入时已归一，这里只做结构兜底，只透出白名单字段，不重新核验稿件。
 */
export function parseStoredBrief(value: unknown): ArticleBrief | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed: Partial<ArticleBrief> | null;
  try {
    parsed = JSON.parse(value) as Partial<ArticleBrief> | null;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || parsed.version !== BRIEF_VERSION) return null;
  if (typeof parsed.tldr !== "string" || !Array.isArray(parsed.key_points)) return null;
  return {
    version: BRIEF_VERSION,
    tldr: parsed.tldr,
    key_points: parsed.key_points.filter((point): point is string => typeof point === "string"),
    quotes: (Array.isArray(parsed.quotes) ? parsed.quotes : [])
      .filter(quote => Boolean(quote) && typeof quote.text === "string" && typeof quote.speaker === "string")
      .map(quote => ({ speaker: quote.speaker, text: quote.text })),
    audience: typeof parsed.audience === "string" ? parsed.audience : "",
    sections: (Array.isArray(parsed.sections) ? parsed.sections : [])
      .filter(section => Boolean(section) && typeof section.heading === "string" && typeof section.summary === "string")
      .map(section => ({ heading: section.heading, summary: section.summary })),
    reading_minutes: typeof parsed.reading_minutes === "number" && Number.isFinite(parsed.reading_minutes) ? parsed.reading_minutes : 0,
  };
}

export function buildBriefMessages(markdown: string, lang: ContentLanguage): Array<{ role: "system" | "user"; content: string }> {
  const headings = extractSectionHeadings(markdown);
  const body = condenseForBrief(markdown);
  return [
    { role: "system", content: lang === "en" ? BRIEF_SYSTEM_PROMPT_EN : BRIEF_SYSTEM_PROMPT },
    { role: "user", content: `${briefInstructions(lang, headings)}${body}\n"""` },
  ];
}

/**
 * 调用 Refinement Provider 生成导读。服务商错误以 RefinerError 原样抛出（由调用方决定是否重试）；
 * 输出无法解析或校验不通过 → null（同一输入重试也不会更好，不值得再计费）。
 */
export async function generateBrief(args: {
  markdown: string;
  lang: ContentLanguage;
  config: Pick<RefinerConfigSnapshot, "apiBase" | "model">;
  apiKey: string;
  fetchFn?: typeof fetch;
}): Promise<ArticleBrief | null> {
  const result = await callChatCompletion({
    apiBase: args.config.apiBase,
    model: args.config.model,
    apiKey: args.apiKey,
    messages: buildBriefMessages(args.markdown, args.lang),
    maxTokens: BRIEF_MAX_OUTPUT_TOKENS,
    temperature: BRIEF_TEMPERATURE,
    timeoutMs: BRIEF_CALL_TIMEOUT_MS,
    fetchFn: args.fetchFn,
  });
  return normalizeBrief(parseBriefJson(result.content), args.markdown);
}
