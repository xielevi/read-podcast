/**
 * 维基百科 API 核验模块。
 *
 * 核心原则：AI 只负责提名候选专有名词，URL 与事实存在性一律由维基百科官方 API 裁定。
 * 绝不让模型编造链接；核验未通过或消歧义页直接剔除，宁缺毋滥。
 *
 * 严格区分「真实无词条」与「网络/服务临时故障」：
 * - 真实无词条（404/消歧义）：视为 not_found，可安全缓存；
 * - 网络故障（超时/5xx/429/连接重置）：视为 error，禁止写入空缓存，触发重试。
 */

export interface ConceptItem {
  term: string;
  wikipedia_title: string;
  summary: string;
  url: string;
}

export type FetchSummaryResult =
  | { status: "found"; title: string; url: string; summary: string }
  | { status: "not_found" }
  | { status: "error"; error: string };

export type SearchWikipediaResult =
  | { status: "found"; title: string }
  | { status: "not_found" }
  | { status: "error"; error: string };

export type ConceptLookupResult =
  | { status: "found"; concept: ConceptItem }
  | { status: "not_found" }
  | { status: "error"; error: string };

export interface VerificationResult {
  concepts: ConceptItem[];
  hasErrors: boolean;
  errorCount: number;
}

const WIKIPEDIA_USER_AGENT = "read-podcast/1.0 (https://github.com/xielevi/read-podcast)";
const SUMMARY_MAX_CHARS = 220;

export function normalizeTitle(text: string): string {
  return text
    .trim()
    .replace(/[（(][^）)]*[）)]\s*$/, "") // 剥除消歧义括号
    .replace(/[\s_·・\-–—]/g, "")         // 剥除空格、居中点与各类破折号
    .toLowerCase();
}

/**
 * 校验搜索返回的标题与原词的相关性。
 * 避免维基百科全文搜索的低相关性噪音（如搜「阿尔法折叠」返回「CASP」）。
 */
export function titlesRelated(term: string, candidate: string): boolean {
  const a = normalizeTitle(term);
  const b = normalizeTitle(candidate);
  if (!a || !b) return false;
  if (a === b) return true;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 2) return false;

  // 针对中文人名翻译：原词通常为姓氏简称（如「韦伯」↔「马克斯·韦伯」）
  if (candidate.includes("·") && longer.endsWith(shorter)) {
    return true;
  }

  // 包含关系匹配：要求长度比例达到 0.6，防止过短匹配（如「AI」误配「AIDS」）
  if (longer.includes(shorter)) {
    return shorter.length / longer.length >= 0.6;
  }

  return false;
}

export async function fetchWikipediaSummary(
  pageTitle: string,
  lang = "zh",
  fetchFn: typeof fetch = fetch,
): Promise<FetchSummaryResult> {
  const safeTitle = encodeURIComponent(pageTitle.replace(/ /g, "_"));
  const endpoint = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${safeTitle}?redirect=true`;

  try {
    const response = await fetchFn(endpoint, {
      headers: {
        "user-agent": WIKIPEDIA_USER_AGENT,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (response.status === 404) {
      return { status: "not_found" };
    }

    if (response.status >= 500 || response.status === 429) {
      return { status: "error", error: `HTTP ${response.status}` };
    }

    if (!response.ok) {
      return { status: "not_found" };
    }

    const data = (await response.json()) as Record<string, unknown>;

    // 消歧义页不是正式词条，视为真实未命中
    if (data.type === "disambiguation") {
      return { status: "not_found" };
    }

    const title = String(data.title || "").trim();
    const urls = (data.content_urls as Record<string, Record<string, unknown>>) || {};
    const url = String(urls.desktop?.page || urls.mobile?.page || "").trim();
    if (!title || !url) {
      return { status: "not_found" };
    }

    let extract = String(data.extract || "")
      .replace(/\s+/g, " ")
      .trim();
    if (extract.length > SUMMARY_MAX_CHARS) {
      extract = `${extract.slice(0, SUMMARY_MAX_CHARS).trimEnd()}…`;
    }

    return { status: "found", title, url, summary: extract };
  } catch (err) {
    console.warn(`Wikipedia summary request failed for "${pageTitle}":`, err);
    return { status: "error", error: String(err) };
  }
}

export async function searchWikipedia(
  term: string,
  lang = "zh",
  fetchFn: typeof fetch = fetch,
): Promise<SearchWikipediaResult> {
  const endpoint = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  endpoint.searchParams.set("action", "query");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("list", "search");
  endpoint.searchParams.set("srsearch", term);
  endpoint.searchParams.set("srlimit", "3");
  endpoint.searchParams.set("srnamespace", "0");

  try {
    const response = await fetchFn(endpoint.toString(), {
      headers: {
        "user-agent": WIKIPEDIA_USER_AGENT,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (response.status >= 500 || response.status === 429) {
      return { status: "error", error: `HTTP ${response.status}` };
    }

    if (!response.ok) {
      return { status: "not_found" };
    }

    const data = (await response.json()) as {
      query?: { search?: Array<{ title?: string }> };
    };
    const results = data.query?.search || [];

    for (const item of results) {
      const candidate = (item.title || "").trim();
      if (candidate && titlesRelated(term, candidate)) {
        return { status: "found", title: candidate };
      }
    }
    return { status: "not_found" };
  } catch (err) {
    console.warn(`Wikipedia search request failed for "${term}":`, err);
    return { status: "error", error: String(err) };
  }
}

export async function lookupConcept(
  term: string,
  lang = "zh",
  fetchFn: typeof fetch = fetch,
): Promise<ConceptLookupResult> {
  // 1. 直查词条名（维基百科内部会自动处理同名规范化与重定向）
  const direct = await fetchWikipediaSummary(term, lang, fetchFn);
  if (direct.status === "found") {
    return {
      status: "found",
      concept: {
        term,
        wikipedia_title: direct.title,
        summary: direct.summary,
        url: direct.url,
      },
    };
  }
  if (direct.status === "error") {
    return direct;
  }

  // 2. 直查确认未命中 (not_found)，退回搜索
  const searched = await searchWikipedia(term, lang, fetchFn);
  if (searched.status === "found") {
    const fromSearch = await fetchWikipediaSummary(searched.title, lang, fetchFn);
    if (fromSearch.status === "found") {
      return {
        status: "found",
        concept: {
          term,
          wikipedia_title: fromSearch.title,
          summary: fromSearch.summary,
          url: fromSearch.url,
        },
      };
    }
    if (fromSearch.status === "error") {
      return fromSearch;
    }
    return { status: "not_found" };
  }
  if (searched.status === "error") {
    return searched;
  }

  return { status: "not_found" };
}

export async function verifyConceptsWikipedia(
  candidates: string[],
  options: { limit?: number; lang?: string; fetchFn?: typeof fetch } = {},
): Promise<VerificationResult> {
  const { limit = 10, lang = "zh", fetchFn = fetch } = options;
  if (!candidates.length) {
    return { concepts: [], hasErrors: false, errorCount: 0 };
  }

  // 保留原提名顺序并发核验
  const lookups = candidates.map(term => lookupConcept(term, lang, fetchFn));
  const results = await Promise.all(lookups);

  const concepts: ConceptItem[] = [];
  const seenTitles = new Set<string>();
  let errorCount = 0;

  for (const item of results) {
    if (item.status === "error") {
      errorCount++;
      continue;
    }
    if (item.status === "found") {
      const key = item.concept.wikipedia_title.toLowerCase();
      if (!seenTitles.has(key)) {
        seenTitles.add(key);
        concepts.push(item.concept);
        if (concepts.length >= limit) break;
      }
    }
  }

  return {
    concepts,
    hasErrors: errorCount > 0,
    errorCount,
  };
}
