/**
 * Refiner / Quality / Formatter / Naming / Concepts golden tests。
 *
 * 迁移不变式：这些行为从 Mac（mac_worker/core/*.py）迁入 Edge，必须逐项保持，
 * 特别是默认杂志级 Prompt、OpenCode session header、deepseek thinking disabled、
 * markdown 围栏抽取、以及命名与既有 writing 仓库产物的字节级一致。
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REFINER_SETTINGS,
  DEFAULT_REFINE_PROMPT,
  DEFAULT_REFINE_PROMPT_EN,
  FALLBACK_REFINE_PROMPT,
  FALLBACK_REFINE_PROMPT_EN,
  REFINE_ERROR_RETENTION,
  REFINE_RETRY_LIMIT,
  REFINE_SUCCESS_RETENTION,
  REFINER_SYSTEM_PROMPT,
  REFINER_SYSTEM_PROMPT_EN,
} from "../src/refinement/defaults";
import {
  RefinerError,
  buildChatRequest,
  buildRefineMessages,
  buildRefinePrompt,
  callChatCompletion,
  extractMarkdown,
  isReasoningModel,
  usesOpencodeSession,
} from "../src/refinement/refiner";
import { countMeaningfulChars, verifyRefinementQuality } from "../src/refinement/quality";
import { formatLocalTimestamp, formatMarkdown, manuscriptTimeZone, stripLeadingFrontmatter } from "../src/refinement/formatter";
import { buildFilenameBase, safeStorageComponent } from "../src/refinement/naming";
import {
  loadRefinerSettings,
  parseRefinerSettingsValues,
  snapshotOf,
  updateRefinerSettings,
} from "../src/refinement/settings";
import {
  filterExcludedTerms,
  parseCandidateTerms,
  proposeConceptCandidates,
  sampleContent,
} from "../src/refinement/concepts";
import type { Env } from "../src/types";

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

/** 断言调用以 RefinerError 失败并返回该错误（保持类型收窄）。 */
async function expectRefinerError(promise: Promise<unknown>): Promise<RefinerError> {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof RefinerError) return caught;
    throw caught;
  }
  throw new Error("expected the call to fail with RefinerError");
}

describe("defaults: 默认杂志级精修 Prompt（Edge 唯一维护者）", () => {
  it("保留关键约束：80% 编辑目标 / 严禁摘要化 / 说话人 / 节目大纲 / 保留思想信息", () => {
    for (const invariant of ["约 80%", "75%–85%", "严禁摘要化", "说话人", "节目大纲", "保留思想与信息"]) {
      expect(DEFAULT_REFINE_PROMPT).toContain(invariant);
    }
  });

  it("包含 {summary} 占位符且不是极简 fallback 模板", () => {
    expect(DEFAULT_REFINE_PROMPT).toContain("{summary}");
    expect(DEFAULT_REFINE_PROMPT.trim()).not.toBe(FALLBACK_REFINE_PROMPT);
    // 完整杂志级 Prompt 的五个必备章节都必须存在（防止退化成极简模板）
    for (const section of ["## 任务定位", "## 工作流程", "## 可做的改写", "## 禁止的改写", "## 篇幅目标", "## 输出格式"]) {
      expect(DEFAULT_REFINE_PROMPT).toContain(section);
    }
    expect(new TextEncoder().encode(DEFAULT_REFINE_PROMPT).byteLength).toBeGreaterThan(2000);
  });

  it("system prompt 与迁移前完全一致", () => {
    expect(REFINER_SYSTEM_PROMPT).toBe("你是一位专业的播客文字整理者。严格按照用户指令处理文本。");
    expect(REFINER_SYSTEM_PROMPT_EN).toBe("You are a professional podcast transcript editor. Follow user instructions strictly.");
  });

  it("英文默认 Prompt 保留同一产品契约", () => {
    for (const invariant of ["approximately 80%", "75%–85%", "Strictly No Summarization", "Speaker Names", "Episode Outline", "Preserve Substantive Thought"]) {
      expect(DEFAULT_REFINE_PROMPT_EN).toContain(invariant);
    }
    expect(DEFAULT_REFINE_PROMPT_EN).toContain("{summary}");
    expect(DEFAULT_REFINE_PROMPT_EN.trim()).not.toBe(FALLBACK_REFINE_PROMPT_EN);
    for (const section of ["## Role & Mission", "## Editorial Workflow", "## Permitted Revisions", "## Prohibited Revisions", "## Length Target", "## Output Format"]) {
      expect(DEFAULT_REFINE_PROMPT_EN).toContain(section);
    }
    expect(new TextEncoder().encode(DEFAULT_REFINE_PROMPT_EN).byteLength).toBeGreaterThan(2000);
  });

  it("生产配置默认值：OpenCode Go + deepseek-v4.1-flash", () => {
    expect(DEFAULT_REFINER_SETTINGS.apiBase).toBe("https://opencode.ai/zen/go/v1");
    expect(DEFAULT_REFINER_SETTINGS.model).toBe("deepseek-v4.1-flash");
    expect(DEFAULT_REFINER_SETTINGS.minOutputRatio).toBe(0.7);
  });

  it("retention 主动收紧：success 1 day / error 3 days", () => {
    expect(REFINE_SUCCESS_RETENTION).toBe("1 day");
    expect(REFINE_ERROR_RETENTION).toBe("3 days");
    expect(REFINE_RETRY_LIMIT).toBe(3);
  });
});

describe("refiner: OpenCode session header 与 thinking 关闭", () => {
  const messages = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "u" }];

  it("OpenCode api_base 必须带 x-opencode-session（随机 UUID）", () => {
    const { headers } = buildChatRequest({
      apiBase: "https://opencode.ai/zen/go/v1",
      model: "deepseek-v4.1-flash",
      apiKey: "k",
      messages,
      maxTokens: 100,
      temperature: 0.3,
    });
    expect(headers["x-opencode-session"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(headers.Authorization).toBe("Bearer k");
    expect(usesOpencodeSession("https://opencode.ai/zen/go/v1")).toBe(true);
  });

  it("显式 sessionId 会被沿用（重试不换会话）", () => {
    const { headers } = buildChatRequest({
      apiBase: "https://opencode.ai/zen/go/v1",
      model: "deepseek-v4.1-flash",
      apiKey: "k",
      messages,
      maxTokens: 100,
      temperature: 0.3,
      sessionId: "11111111-2222-3333-4444-555555555555",
    });
    expect(headers["x-opencode-session"]).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("非 OpenCode api_base 不带 session header", () => {
    const { headers } = buildChatRequest({
      apiBase: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "k",
      messages,
      maxTokens: 100,
      temperature: 0.3,
    });
    expect(headers["x-opencode-session"]).toBeUndefined();
  });

  it("deepseek v4 / reasoner → thinking.type = disabled；其他模型不带 thinking", () => {
    const base = {
      apiBase: "https://opencode.ai/zen/go/v1",
      apiKey: "k",
      messages,
      maxTokens: 100,
      temperature: 0.3,
    };
    expect(isReasoningModel("deepseek-v4.1-flash")).toBe(true);
    expect(isReasoningModel("deepseek-reasoner")).toBe(true);
    expect(isReasoningModel("gpt-4o")).toBe(false);

    const reasoning = buildChatRequest({ ...base, model: "deepseek-v4.1-flash" });
    expect(reasoning.body.thinking).toEqual({ type: "disabled" });

    const plain = buildChatRequest({ ...base, model: "gpt-4o" });
    expect(plain.body.thinking).toBeUndefined();
  });

  it("model / temperature / max_tokens 严格取自配置", () => {
    const { body } = buildChatRequest({
      apiBase: "https://opencode.ai/zen/go/v1",
      model: "deepseek-v4.1-flash",
      apiKey: "k",
      messages,
      maxTokens: 65536,
      temperature: 0.3,
    });
    expect(body.model).toBe("deepseek-v4.1-flash");
    expect(body.max_tokens).toBe(65536);
    expect(body.temperature).toBe(0.3);
  });
});

describe("refiner: extractMarkdown / prompt 组装", () => {
  it("抽取 ```markdown 围栏", () => {
    expect(extractMarkdown("前言\n```markdown\n# 标题\n正文\n```\n后记")).toBe("# 标题\n正文");
  });

  it("抽取无语言标注围栏，多段围栏合并", () => {
    expect(extractMarkdown("```\nA\n```\n```\nB\n```")).toBe("A\n\nB");
  });

  it("无围栏时返回 trim 后的原文", () => {
    expect(extractMarkdown("  # 标题  ")).toBe("# 标题");
  });

  it("默认 Prompt 替换 {summary}，custom prompt 优先", () => {
    const prompt = buildRefinePrompt("某期节目简介");
    expect(prompt).toContain("某期节目简介");
    expect(prompt).not.toContain("{summary}");
    expect(prompt).toContain("严禁摘要");

    const custom = buildRefinePrompt("某期节目简介", "自定义 {summary} 模板");
    expect(custom).toBe("自定义 某期节目简介 模板");

    const customNoPlaceholder = buildRefinePrompt("某期节目简介", "固定模板");
    expect(customNoPlaceholder).toBe("固定模板");

    const fallback = buildRefinePrompt("简介", null, "");
    expect(fallback).toBe("节目简介: 简介");
  });

  it("messages: system 固定角色 + user = prompt\\n\\nraw", () => {
    const messages = buildRefineMessages("PROMPT", "RAW");
    expect(messages).toEqual([
      { role: "system", content: REFINER_SYSTEM_PROMPT },
      { role: "user", content: "PROMPT\n\nRAW" },
    ]);
  });
});

describe("refiner: 错误分类（429/5xx/timeout → retry；401/400 → non-retry）", () => {
  const call = (fetchFn: typeof fetch, overrides: Partial<Parameters<typeof callChatCompletion>[0]> = {}) =>
    callChatCompletion({
      apiBase: "https://opencode.ai/zen/go/v1",
      model: "deepseek-v4.1-flash",
      apiKey: "k",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      temperature: 0.3,
      fetchFn,
      ...overrides,
    });

  it("429 → retryable + 采用 Retry-After", async () => {
    const fetchFn = (async () =>
      new Response("rate limited", { status: 429, headers: { "retry-after": "42" } })) as unknown as typeof fetch;
    await expect(call(fetchFn)).rejects.toMatchObject({
      code: "refine_api_failed",
      retryable: true,
      retryAfterSeconds: 42,
    });
  });

  it("5xx → retryable", async () => {
    const fetchFn = (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
    const error = await expectRefinerError(call(fetchFn));
    expect(error).toBeInstanceOf(RefinerError);
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("refine_api_failed");
  });

  it("408 → retryable", async () => {
    const fetchFn = (async () => new Response("timeout", { status: 408 })) as unknown as typeof fetch;
    const error = await expectRefinerError(call(fetchFn));
    expect(error.retryable).toBe(true);
  });

  it("401 → non-retryable refine_provider_auth", async () => {
    const fetchFn = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const error = await expectRefinerError(call(fetchFn));
    expect(error.code).toBe("refine_provider_auth");
    expect(error.retryable).toBe(false);
  });

  it("400 → non-retryable refine_provider_bad_request", async () => {
    const fetchFn = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const error = await expectRefinerError(call(fetchFn));
    expect(error.code).toBe("refine_provider_bad_request");
    expect(error.retryable).toBe(false);
  });

  it("连接错误 / 超时（fetch 抛错）→ retryable", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const error = await expectRefinerError(call(fetchFn));
    expect(error.code).toBe("refine_api_failed");
    expect(error.retryable).toBe(true);
  });

  it("缺少 REFINER_API_KEY → non-retryable（配置问题）", async () => {
    const error = await expectRefinerError(call((async () => jsonResponse({})) as unknown as typeof fetch, { apiKey: "" }));
    expect(error.code).toBe("refine_provider_auth");
    expect(error.retryable).toBe(false);
  });

  it("空内容 → retryable", async () => {
    const fetchFn = (async () =>
      jsonResponse({ choices: [{ message: { content: "   " }, finish_reason: "stop" }] })) as unknown as typeof fetch;
    const error = await expectRefinerError(call(fetchFn));
    expect(error.retryable).toBe(true);
  });

  it("成功返回 content", async () => {
    const fetchFn = (async () =>
      jsonResponse({ choices: [{ message: { content: "# 成稿" }, finish_reason: "stop" }] })) as unknown as typeof fetch;
    const result = await call(fetchFn);
    expect(result.content).toBe("# 成稿");
    expect(result.finishReason).toBe("stop");
  });
});

describe("quality gate: 70% 硬下限 + 独立结构门控", () => {
  const longRaw = "这是一段原始转录内容。".repeat(200);

  it("约 80% 且具备结构特征 → pass", () => {
    const edited = longRaw.slice(0, Math.floor(longRaw.length * 0.8));
    const refined = `### 📌 节目大纲与时间线\n- **01:20** 话题\n\n## 01 | 标题\n\n**程衍樑**：${edited}`;
    const result = verifyRefinementQuality(refined, longRaw);
    expect(result.valid).toBe(true);
    expect(result.features).toEqual(expect.arrayContaining(["has_header", "has_bold", "has_speaker", "has_outline"]));
    expect(result.features.some(feature => feature.startsWith("length_ratio:"))).toBe(true);
  });

  it("低于 70% 时，即使结构特征齐全也 fail", () => {
    const edited = longRaw.slice(0, Math.floor(longRaw.length * 0.5));
    const refined = `### 📌 节目大纲与时间线\n- **01:20** 话题\n\n## 01 | 标题\n\n**程衍樑**：${edited}`;
    const result = verifyRefinementQuality(refined, longRaw);
    expect(result.features).toEqual(expect.arrayContaining(["has_header", "has_bold", "has_speaker", "has_outline"]));
    expect(result.features.some(feature => feature.startsWith("too_short:"))).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("达到长度底线但缺少 Markdown 结构 → fail", () => {
    const plain = longRaw;
    const result = verifyRefinementQuality(plain, longRaw);
    expect(result.valid).toBe(false);
    expect(result.score).toBeLessThan(2);
  });

  it("countMeaningfulChars 忽略空白", () => {
    expect(countMeaningfulChars("a b\nc")).toBe(3);
  });
});

describe("formatter: frontmatter 与 canonical metadata", () => {
  const episode = {
    title: "474 孙立天谈康熙废储（精修）",
    podcast_name: "忽左忽右",
    published: "Tue, 19 May 2026 08:00:00 +0000",
    duration: "01:02:03",
    audio_url: "https://example.com/a.mp3",
    link: "https://example.com/ep",
  };

  it("包含全部 canonical frontmatter 字段", () => {
    const md = formatMarkdown(episode, "正文", [], { refinement_success: true, transcript_source: "ai_refined" });
    expect(md.startsWith("---\n")).toBe(true);
    for (const key of ["title:", "podcast:", "date:", "duration:", "link:", "source_link:", "tags:", "processed_at:"]) {
      expect(md).toContain(key);
    }
    expect(md).toContain("refinement_success: true");
    expect(md).toContain("transcript_source: ai_refined");
    expect(md).toContain("*Generated by Read Podcast*");
    expect(md).toContain("\n正文\n");
  });

  it("特殊字符按 YAML 安全规则加引号（含全角括号保持裸写）", () => {
    const md = formatMarkdown({ ...episode, title: "Vol.1: 标题" }, "正文");
    expect(md).toContain("title: 'Vol.1: 标题'");
    const fullwidth = formatMarkdown({ ...episode, title: "（精修）标题" }, "正文");
    expect(fullwidth).toContain("title: （精修）标题");
  });

  it("空 tags → tags: []；非空 → YAML 列表", () => {
    expect(formatMarkdown(episode, "正文", [])).toContain("tags: []");
    expect(formatMarkdown(episode, "正文", ["播客", "历史"])).toContain("tags:\n- 播客\n- 历史");
  });

  it("去除模型自带 frontmatter；processed_at 使用 Asia/Shanghai", () => {
    const body = stripLeadingFrontmatter("---\ntitle: x\n---\n\n正文");
    expect(body).toBe("正文");
    expect(formatLocalTimestamp(new Date("2026-09-20T00:00:00Z"))).toBe("2026-09-20 08:00:00");
  });

  it("MANUSCRIPT_TIME_ZONE 可覆盖 processed_at 时区；缺省或无效时回退 Asia/Shanghai", () => {
    expect(manuscriptTimeZone(undefined)).toBe("Asia/Shanghai");
    expect(manuscriptTimeZone("  ")).toBe("Asia/Shanghai");
    expect(manuscriptTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(manuscriptTimeZone("Mars/Olympus_Mons")).toBe("Asia/Shanghai");
    warn.mockRestore();

    const now = new Date("2026-09-20T00:00:00Z");
    expect(formatMarkdown(episode, "正文", [], null, now)).toContain("processed_at: '2026-09-20 08:00:00'");
    expect(formatMarkdown(episode, "正文", [], null, now, "America/New_York")).toContain("processed_at: '2026-09-19 20:00:00'");
  });
});

describe("naming: 与既有 writing 产物字节级一致", () => {
  it("数字集号形态", async () => {
    const base = await buildFilenameBase("忽左忽右", "20260519", "474 孙立天谈康熙废储（精修）");
    expect(base).toBe("20260519_忽左忽右_474_孙立天谈康熙废储（精修）");
  });

  it("Vol 形态", async () => {
    const base = await buildFilenameBase("东腔西调", "20260318", "Vol.260｜特朗普关税");
    expect(base).toBe("20260318_东腔西调_Vol.260_特朗普关税");
  });

  it("普通标题：全角括号不做 NFKC", async () => {
    const base = await buildFilenameBase("忽左忽右", "20260519", "谈谈（康熙）废储");
    expect(base).toBe("20260519_忽左忽右_谈谈（康熙）废储");
  });

  it("不安全字符被替换并追加 sha256 短摘要", async () => {
    const out = await safeStorageComponent("节目/名:x");
    expect(out).not.toContain("/");
    expect(out.startsWith("节目_名:x-")).toBe(true);
    expect(out.split("-").pop()).toHaveLength(10);
  });
});

describe("settings: D1 refiner_settings 读写与校验", () => {
  const envWithRow = (row: Record<string, unknown> | null): Env => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => row,
          run: async () => ({ meta: { changes: 1 } }),
        }),
        first: async () => row,
      }),
    };
    return ({
      db,
      DB: db,
    }) as unknown as Env;
  };

  it("无行时使用内建默认（生产 OpenCode 配置）", async () => {
    const settings = await loadRefinerSettings(envWithRow(null));
    expect(settings.apiBase).toBe(DEFAULT_REFINER_SETTINGS.apiBase);
    expect(settings.model).toBe(DEFAULT_REFINER_SETTINGS.model);
    expect(settings.minOutputRatio).toBe(0.7);
  });

  it("有行时读取 D1 值", async () => {
    const settings = await loadRefinerSettings(
      envWithRow({
        api_base: "https://example.com/v1",
        model: "custom-model",
        temperature: 0.5,
        max_tokens: 4096,
        min_output_ratio: 0.95,
        updated_at: "2026-09-20T00:00:00Z",
      }),
    );
    expect(settings).toMatchObject({ apiBase: "https://example.com/v1", model: "custom-model", temperature: 0.5, maxTokens: 4096, minOutputRatio: 0.95 });
    expect(snapshotOf(settings)).toEqual({
      apiBase: "https://example.com/v1",
      model: "custom-model",
      temperature: 0.5,
      maxTokens: 4096,
      minOutputRatio: 0.95,
    });
  });

  it("校验：非法 api_base / 空 model / 越界数值一律拒绝", () => {
    expect(() => parseRefinerSettingsValues({ "refiner.api_base": "ftp://x" })).toThrow();
    expect(() => parseRefinerSettingsValues({ "refiner.model": "" })).toThrow();
    expect(() => parseRefinerSettingsValues({ "refiner.temperature": "3" })).toThrow();
    expect(() => parseRefinerSettingsValues({ "refiner.max_tokens": "0" })).toThrow();
    expect(() => parseRefinerSettingsValues({ "refiner.min_output_ratio": "1.5" })).toThrow();
  });

  it("校验：合法值被规范化（去尾斜杠 / 数值化）", () => {
    const parsed = parseRefinerSettingsValues({
      "refiner.api_base": "https://opencode.ai/zen/go/v1/",
      "refiner.model": " deepseek-v4.1-flash ",
      "refiner.temperature": "0.3",
      "refiner.max_tokens": "65536",
      "refiner.min_output_ratio": "0.9",
    });
    expect(parsed).toEqual({
      apiBase: "https://opencode.ai/zen/go/v1",
      model: "deepseek-v4.1-flash",
      temperature: 0.3,
      maxTokens: 65536,
      minOutputRatio: 0.9,
    });
  });

  it("updateRefinerSettings 使用 upsert 单行写入（合并现有值）", async () => {
    const statements: string[] = [];
    let insertBindings: unknown[] = [];
    const db = {
      prepare: (statement: string) => {
        statements.push(statement);
        return {
          bind: (...args: unknown[]) => {
            if (statement.includes("INSERT INTO refiner_settings")) insertBindings = args;
            return {
              run: async () => ({ meta: { changes: 1 } }),
              first: async () => null,
            };
          },
          first: async () => null,
        };
      },
    };
    const env = {
      db,
      DB: db,
    } as unknown as Env;
    await updateRefinerSettings(env, { model: "m2" });
    const insert = statements.find(statement => statement.includes("INSERT INTO refiner_settings"));
    expect(insert).toBeTruthy();
    expect(insert).toContain("ON CONFLICT(id) DO UPDATE SET");
    // 未提供的字段沿用现有值（默认配置），model 被覆盖
    expect(insertBindings[0]).toBe(DEFAULT_REFINER_SETTINGS.apiBase);
    expect(insertBindings[1]).toBe("m2");
    expect(insertBindings[4]).toBe(0.7);
  });
});

describe("concepts: 候选解析（Mac 行为迁移）", () => {
  it("解析 {\"concepts\": [...]}、纯列表与对象列表", () => {
    expect(parseCandidateTerms('{"concepts": ["马克斯·韦伯", "新教伦理"]}')).toEqual(["马克斯·韦伯", "新教伦理"]);
    expect(parseCandidateTerms('["甲午战争", "新教伦理"]')).toEqual(["甲午战争", "新教伦理"]);
    expect(parseCandidateTerms('[{"term": "马克斯·韦伯"}, {"name": "新教伦理"}]')).toEqual(["马克斯·韦伯", "新教伦理"]);
  });

  it("容忍代码围栏与散文包裹；清洗引号书名号；去重", () => {
    expect(parseCandidateTerms('```json\n{"concepts": ["《万历十五年》", "「甲午战争」", "甲午战争"]}\n```')).toEqual([
      "万历十五年",
      "甲午战争",
    ]);
    expect(parseCandidateTerms("前置说明 {\"concepts\": [\"马克斯·韦伯\"]} 后置")).toEqual(["马克斯·韦伯"]);
  });

  it("过滤播客名 / 单集标题本身", () => {
    expect(filterExcludedTerms(["忽左忽右", "许知远"], "忽左忽右", "忽左忽右")).toEqual(["许知远"]);
  });

  it("超长文本分段抽样仍保留首尾", () => {
    const text = Array.from({ length: 200 }, (_, index) => `第${index}段内容`).join("\n\n");
    const sampled = sampleContent(text, 500);
    expect(sampled.length).toBeLessThan(text.length);
    expect(sampled).toContain("第0段内容");
    expect(sampled).toContain("第199段内容");
    expect(sampled).toContain("抽样");
  });

  it("proposeConceptCandidates 调用 refiner client 并过滤", async () => {
    const calls: Array<{ messages: unknown; options: unknown }> = [];
    const client = {
      async chat(messages: unknown, options: unknown) {
        calls.push({ messages, options });
        return { content: '{"concepts": ["马克斯·韦伯", "测试播客", "新教伦理"]}', finishReason: "stop" };
      },
    };
    const candidates = await proposeConceptCandidates(
      { title: "韦伯与现代化", podcast: "测试播客", content: "正文内容", limit: 5 },
      client as never,
    );
    expect(candidates).toEqual(["马克斯·韦伯", "新教伦理"]);
    expect(calls).toHaveLength(1);
    expect((calls[0].options as { temperature: number }).temperature).toBe(0.2);
  });

  it("Chinese transcript -> en concepts: instructs LLM to canonicalize to English Wikipedia terms", async () => {
    const calls: Array<{ messages: Array<{ role: string; content: string }>; options: unknown }> = [];
    const client = {
      async chat(messages: Array<{ role: string; content: string }>, options: unknown) {
        calls.push({ messages, options });
        return { content: '{"concepts": ["Max Weber", "The Protestant Ethic and the Spirit of Capitalism"]}', finishReason: "stop" };
      },
    };
    const candidates = await proposeConceptCandidates(
      { title: "韦伯与现代化", podcast: "忽左忽右", content: "今天我们聊一聊马克斯·韦伯的社会学理论与新教伦理。", lang: "en" },
      client as never,
    );
    expect(candidates).toEqual(["Max Weber", "The Protestant Ethic and the Spirit of Capitalism"]);
    expect(calls).toHaveLength(1);
    const systemContent = calls[0].messages[0].content;
    const userContent = calls[0].messages[1].content;
    expect(systemContent).toContain("English Wikipedia (en.wikipedia.org)");
    expect(systemContent).toContain("Target language canonicalization");
    expect(userContent).toContain("Output all canonical concept terms in English even if the transcript is in another language");
  });

  it("English transcript -> zh concepts: instructs LLM to canonicalize to Chinese Wikipedia terms", async () => {
    const calls: Array<{ messages: Array<{ role: string; content: string }>; options: unknown }> = [];
    const client = {
      async chat(messages: Array<{ role: string; content: string }>, options: unknown) {
        calls.push({ messages, options });
        return { content: '{"concepts": ["马克斯·韦伯", "新教伦理与资本主义精神"]}', finishReason: "stop" };
      },
    };
    const candidates = await proposeConceptCandidates(
      { title: "Weber and Capitalism", podcast: "Philosophy Now", content: "Today we discuss Max Weber and the Protestant ethic.", lang: "zh" },
      client as never,
    );
    expect(candidates).toEqual(["马克斯·韦伯", "新教伦理与资本主义精神"]);
    expect(calls).toHaveLength(1);
    const systemContent = calls[0].messages[0].content;
    const userContent = calls[0].messages[1].content;
    expect(systemContent).toContain("中文维基百科（zh.wikipedia.org）");
    expect(systemContent).toContain("目标语言规范");
    expect(userContent).toContain("无论文字稿原文为何种语言，请将候选词条输出为适合在中文维基百科检索的中文标准规范名称");
  });

  it("空内容不调用模型", async () => {
    const client = {
      async chat() {
        throw new Error("should not be called");
      },
    };
    expect(await proposeConceptCandidates({ title: "t", podcast: "p", content: "  " }, client as never)).toEqual([]);
  });
});
