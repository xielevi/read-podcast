/**
 * 关键概念提名（行为迁移自 mac_worker/core/concepts.py）。
 *
 * 由 LLM 仅负责提名值得查阅的专有名词（人物、机构、事件、理论术语、作品），
 * 维基百科的存在性核验由 Edge 的 wikipedia 模块完成；缓存仍在 D1 article_concepts。
 * 即使转录服务完全下线，已生成稿件仍可完成概念提取与核验。
 */
import type { RefinerClient } from "./refiner";

export const MAX_CANDIDATES = 12;
export const DEFAULT_CANDIDATES = 10;
export const MAX_TERM_LENGTH = 60;
export const MAX_CONTEXT_CHARS = 24000;

export const CONCEPTS_SYSTEM_PROMPT =
  "你是知识编辑，负责从播客精修文字稿中挑出最值得读者在维基百科延伸查阅的关键专有名词。\n" +
  "【挑选原则】\n" +
  "1. 优先提取：人物、机构/组织、历史事件、学科理论、专业术语、重要作品、重要地名。\n" +
  "2. 严格排除：日常泛用词（如「沟通」「时代」「逻辑」「方法」「问题」）、文字稿所属播客名或本集标题本身、常识词汇。\n" +
  "3. 独立词条：只选维基百科上极可能拥有独立条目的专有名词，不带修饰短语（如选「马克斯·韦伯」而非「韦伯的学术思想」）。\n" +
  "4. 数量与格式：按重要性从高到低排序，只返回合法的 JSON 对象，形如 {\"concepts\": [\"概念1\", \"概念2\"]}，严禁输出任何额外解释或散文。";

export const CONCEPTS_SYSTEM_PROMPT_EN =
  "You are a knowledge editor responsible for selecting key proper nouns and concepts from podcast transcripts that are most worth readers looking up on Wikipedia.\n" +
  "[Selection Principles]\n" +
  "1. Prioritize: People, organizations/institutions, historical events, academic theories, technical/domain terms, notable works, significant locations.\n" +
  "2. Strictly exclude: Everyday generic words (e.g., 'communication', 'era', 'logic', 'method', 'problem'), the podcast show name or episode title itself, and common knowledge words.\n" +
  "3. Standalone entries: Only select proper nouns highly likely to have standalone Wikipedia articles, without modifying phrases (e.g., select 'Max Weber' rather than 'Weber's academic thought').\n" +
  "4. Quantity and format: Rank from most important to least important, return only a valid JSON object of the form {\"concepts\": [\"Concept 1\", \"Concept 2\"]}. Never output any additional explanation or prose.";

export function stripCodeFence(text: string): string {
  let value = String(text ?? "").trim();
  if (value.startsWith("```")) {
    value = value.replace(/^```[a-zA-Z]*\s*/, "");
    value = value.replace(/\s*```$/, "");
  }
  return value.trim();
}

/** 如果文字稿超出预算，采用分段均匀抽样，避免后半篇概念永远无法入选。 */
export function sampleContent(text: string, budget: number = MAX_CONTEXT_CHARS): string {
  const body = String(text ?? "").trim();
  if (body.length <= budget) return body;

  const paragraphs = body.split("\n\n").map(part => part.trim()).filter(Boolean);
  if (!paragraphs.length) return body.slice(0, budget);

  // 保留开头 ~30% 与结尾 ~30%，中间等距均匀采样 ~40%
  const headBudget = Math.trunc(budget * 0.3);
  const tailBudget = Math.trunc(budget * 0.3);
  const midBudget = budget - headBudget - tailBudget;

  const headParts: string[] = [];
  let headLength = 0;
  let headIndex = 0;
  while (headIndex < paragraphs.length && headLength < headBudget) {
    const paragraph = paragraphs[headIndex];
    headParts.push(paragraph);
    headLength += paragraph.length;
    headIndex += 1;
  }

  const tailParts: string[] = [];
  let tailLength = 0;
  let tailIndex = paragraphs.length - 1;
  while (tailIndex >= headIndex && tailLength < tailBudget) {
    const paragraph = paragraphs[tailIndex];
    tailParts.unshift(paragraph);
    tailLength += paragraph.length;
    tailIndex -= 1;
  }

  const midParagraphs = paragraphs.slice(headIndex, tailIndex + 1);
  const midParts: string[] = [];
  if (midParagraphs.length) {
    const step = Math.max(1, Math.trunc(midParagraphs.length / 10));
    let midLength = 0;
    for (let index = 0; index < midParagraphs.length; index += step) {
      const paragraph = midParagraphs[index];
      if (midLength + paragraph.length > midBudget) break;
      midParts.push(paragraph);
      midLength += paragraph.length;
    }
  }

  return (
    headParts.join("\n\n") +
    "\n\n[...篇幅较长，中间章节抽样...]\n\n" +
    midParts.join("\n\n") +
    "\n\n[...尾部章节...]\n\n" +
    tailParts.join("\n\n")
  );
}

/** 健壮解析模型返回的 JSON；支持 {"concepts": [...]}、纯列表或携带 reason 的对象列表。 */
export function parseCandidateTerms(raw: string): string[] {
  const cleaned = stripCodeFence(raw);
  let data: unknown = null;
  try {
    data = JSON.parse(cleaned);
  } catch {
    const match = /(\{[\s\S]*\}|\[[\s\S]*\])/.exec(cleaned);
    if (match) {
      try {
        data = JSON.parse(match[1]);
      } catch {
        data = null;
      }
    }
  }

  let items: unknown[] = [];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const key of ["concepts", "terms", "candidates", "result"]) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        items = value;
        break;
      }
    }
  } else if (Array.isArray(data)) {
    items = data;
  }

  const terms: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    let term = "";
    if (typeof item === "string") {
      term = item;
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      term = String(record.term ?? record.name ?? record.concept ?? "");
    } else {
      continue;
    }

    // 清洗标点、空白和首尾各种引号/书名号
    term = term.replace(/^[\s"'“”‘’《〈（(【\[「『]+/, "").replace(/[\s"'“”‘’》〉）)】\]」』]+$/, "").trim();
    term = term.slice(0, MAX_TERM_LENGTH).trim();

    if (!term || term.length < 2) continue;
    // 过滤全数字或全标点（Unicode 字母判定）
    if (!/\p{L}/u.test(term)) continue;

    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }

  return terms;
}

/** 过滤掉与播客节目名或单集标题完全相同的候选。 */
export function filterExcludedTerms(terms: string[], title: string, podcast: string): string[] {
  const blacklist = new Set([String(title ?? "").trim().toLocaleLowerCase(), String(podcast ?? "").trim().toLocaleLowerCase()]);
  const filtered: string[] = [];
  for (const term of terms) {
    const key = term.toLocaleLowerCase();
    if (blacklist.has(key)) continue;
    filtered.push(term);
  }
  return filtered;
}

export interface ConceptCandidateInput {
  title: string;
  podcast: string;
  content: string;
  limit?: number;
  lang?: "zh" | "en";
}

/** 调用 LLM 提名候选概念（数量略多要 2-3 个备选以抵消维基核验损耗）。 */
export async function proposeConceptCandidates(input: ConceptCandidateInput, client: RefinerClient): Promise<string[]> {
  const body = String(input.content ?? "").trim();
  if (!body) return [];

  const lang = input.lang === "en" ? "en" : "zh";
  const targetCount = Math.max(1, Math.min(Math.trunc(input.limit ?? DEFAULT_CANDIDATES), MAX_CANDIDATES));
  const requestCount = Math.min(MAX_CANDIDATES, targetCount + 3);

  const sampledText = sampleContent(body, MAX_CONTEXT_CHARS);
  const header = lang === "en"
    ? `"${input.title}"` + (input.podcast ? ` (Podcast: ${input.podcast})` : "")
    : `《${input.title}》` + (input.podcast ? `（播客：${input.podcast}）` : "");
  const userPrompt = lang === "en"
    ? `Podcast episode: ${header}\nPlease select ${requestCount} key concepts most worth looking up on Wikipedia from the following transcript:\n\n"""\n${sampledText}\n"""`
    : `播客单集：${header}\n请从以下文字稿中挑选 ${requestCount} 个最值得在维基百科查阅的关键概念：\n\n"""\n${sampledText}\n"""`;

  const systemPrompt = lang === "en" ? CONCEPTS_SYSTEM_PROMPT_EN : CONCEPTS_SYSTEM_PROMPT;

  const result = await client.chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    { maxTokens: 800, temperature: 0.2 },
  );

  const candidates = parseCandidateTerms(result.content);
  const cleanCandidates = filterExcludedTerms(candidates, input.title, input.podcast);
  return cleanCandidates.slice(0, MAX_CANDIDATES);
}
