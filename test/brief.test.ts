/**
 * 稿件导读（Article Brief）：渐进式阅读第一层。
 *
 * 覆盖：模型输出的校验 / 归一（伪造标题、非逐字引用、超长、超量、坏 JSON）、确定性阅读时长、
 * 超长稿件按节压缩、frontmatter 嵌入与旧稿件兼容；generate-brief step 的尽力而为语义
 * （失败 → brief = null 但任务照常 success、可重试错误有限重试、重放不重复计费、取消照常传播）；
 * 发布时与 article upsert 同 batch 写入 articles.brief；公共 / 控制面 DTO 的白名单暴露。
 */
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { persistFinalArticle } from "../src/finalize";
import {
  BRIEF_LIMITS,
  BRIEF_SYSTEM_PROMPT_EN,
  buildBriefMessages,
  computeReadingMinutes,
  condenseForBrief,
  extractSectionHeadings,
  normalizeBrief,
  parseBriefJson,
  parseStoredBrief,
  type ArticleBrief,
} from "../src/refinement/brief";
import { formatMarkdown, stripLeadingFrontmatter } from "../src/refinement/formatter";
import { BRIEF_SKIP_STEP, BRIEF_STEP, PUBLISH_STEP, REFINE_STEP, runProcessingPipeline } from "../src/workflows/pipeline";
import { processingWorkflowId } from "../src/workflows/processing";
import {
  ATTEMPT,
  BRIEF_RESPONSE,
  DurableStepEngine,
  FAST_POLL,
  REFINED_TEXT,
  TASK,
  insertTask,
  makeCloud,
  paramsFor,
  taskRow,
  type Cloud,
} from "./helpers/cloud";

const MANUSCRIPT = [
  "### 📌 节目大纲与时间线",
  "- **00:00** 开场",
  "",
  "## 01 | 为什么要读长文",
  "",
  "**许知远**：真正的阅读需要时间，我们不能把一切都压缩成摘要。",
  "",
  "## 02 | **算法**与注意力",
  "",
  "**程衍樑**：推荐算法改变了我们分配注意力的方式。",
].join("\n");

const VALID = {
  version: 1,
  tldr: "  两位主播讨论长文阅读与注意力。 ",
  key_points: ["阅读需要时间", "算法改变注意力", "摘要不能替代全文"],
  quotes: [{ speaker: "许知远", text: "真正的阅读需要时间" }],
  audience: "关心阅读习惯的人。",
  sections: [
    { heading: "02 | 算法与注意力", summary: "讨论推荐算法。" },
    { heading: "01 | 为什么要读长文", summary: "为长文辩护。" },
  ],
  reading_minutes: 120,
};

describe("normalizeBrief：代码拥有读者依赖的事实，不信任模型", () => {
  it("合法输出：裁剪空白、按稿件顺序回写真实标题原文、reading_minutes 由代码计算", () => {
    const brief = normalizeBrief(VALID, MANUSCRIPT)!;
    expect(brief.version).toBe(1);
    expect(brief.tldr).toBe("两位主播讨论长文阅读与注意力。");
    expect(brief.sections.map(section => section.heading)).toEqual(["01 | 为什么要读长文", "02 | **算法**与注意力"]);
    expect(brief.reading_minutes).toBe(computeReadingMinutes(MANUSCRIPT));
    expect(brief.reading_minutes).not.toBe(120);
    expect(brief.quotes).toEqual([{ speaker: "许知远", text: "真正的阅读需要时间" }]);
  });

  it("丢弃对不上真实小节的标题、大纲标题与重复标题", () => {
    const brief = normalizeBrief({
      ...VALID,
      sections: [
        { heading: "03 | 模型编造的小节", summary: "不存在" },
        { heading: "📌 节目大纲与时间线", summary: "大纲不是小节" },
        { heading: "## 01 | 为什么要读长文", summary: "保留（容忍 # 前缀）" },
        { heading: "01 | 为什么要读长文", summary: "重复" },
        { heading: "02 | 算法与注意力", summary: "" },
      ],
    }, MANUSCRIPT)!;
    expect(brief.sections).toEqual([{ heading: "01 | 为什么要读长文", summary: "保留（容忍 # 前缀）" }]);
  });

  it("引用必须逐字出现在稿件中（容忍强调符号与引号差异），转述 / 超量被丢弃", () => {
    const brief = normalizeBrief({
      ...VALID,
      quotes: [
        { speaker: "许知远", text: "阅读真的需要很多时间" }, // 转述
        { speaker: "程衍樑", text: "“推荐算法改变了我们分配注意力的方式。”" },
        { speaker: "许知远", text: "我们不能把一切都压缩成摘要" },
        { speaker: "许知远", text: "真正的阅读需要时间" },
        { speaker: "许知远", text: "真正的阅读" }, // 第四条：超量
        "not an object",
      ],
    }, MANUSCRIPT)!;
    expect(brief.quotes.map(quote => quote.text)).toEqual([
      "推荐算法改变了我们分配注意力的方式。",
      "我们不能把一切都压缩成摘要",
      "真正的阅读需要时间",
    ]);
  });

  it("截断超长字段与超量要点", () => {
    const brief = normalizeBrief({
      ...VALID,
      tldr: "长".repeat(1000),
      key_points: Array.from({ length: 10 }, (_, index) => `要点${index}`.padEnd(500, "。")),
      audience: "人".repeat(1000),
    }, MANUSCRIPT)!;
    expect(brief.tldr.length).toBe(BRIEF_LIMITS.tldr);
    expect(brief.tldr.endsWith("…")).toBe(true);
    expect(brief.key_points).toHaveLength(BRIEF_LIMITS.maxKeyPoints);
    expect(brief.key_points.every(point => point.length <= BRIEF_LIMITS.keyPoint)).toBe(true);
    expect(brief.audience.length).toBe(BRIEF_LIMITS.audience);
  });

  it.each([
    ["不是对象", "hello"],
    ["数组", [VALID]],
    ["缺 tldr", { ...VALID, tldr: "" }],
    ["要点不足 3 条", { ...VALID, key_points: ["一", "二"] }],
    ["要点不是数组", { ...VALID, key_points: "一、二、三" }],
  ])("不满足最低要求（%s）→ null", (_label, raw) => {
    expect(normalizeBrief(raw, MANUSCRIPT)).toBeNull();
  });

  it("parseBriefJson 容忍代码围栏与前后废话；无法解析 → null", () => {
    expect(parseBriefJson("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(parseBriefJson("好的，以下是导读：{\"a\":1} 希望有帮助")).toEqual({ a: 1 });
    expect(parseBriefJson("完全不是 JSON")).toBeNull();
    expect(parseBriefJson("{\"a\":")).toBeNull();
  });

  it("parseStoredBrief：只透出白名单字段；空 / 损坏 / 未知版本 → null", () => {
    const stored = JSON.stringify({ ...normalizeBrief(VALID, MANUSCRIPT), secret: "x", sections: [{ heading: "h", summary: "s", extra: 1 }] });
    const parsed = parseStoredBrief(stored)!;
    expect(Object.keys(parsed).sort()).toEqual(["audience", "key_points", "quotes", "reading_minutes", "sections", "tldr", "version"]);
    expect(parsed.sections).toEqual([{ heading: "h", summary: "s" }]);
    expect(parseStoredBrief(null)).toBeNull();
    expect(parseStoredBrief("")).toBeNull();
    expect(parseStoredBrief("{broken")).toBeNull();
    expect(parseStoredBrief(JSON.stringify({ ...VALID, version: 2 }))).toBeNull();
  });
});

describe("稿件结构工具", () => {
  it("extractSectionHeadings：h1–h3、排除开头大纲（中英）、忽略代码块内的 #", () => {
    const text = `---\ntitle: x\n---\n### 📌 Episode Outline & Timeline\n- a\n\n# Title\n\n## 01 | Intro ##\n\n\`\`\`\n# not a heading\n\`\`\`\n\n#### too deep\n`;
    expect(extractSectionHeadings(text)).toEqual(["Title", "01 | Intro"]);
    expect(extractSectionHeadings(MANUSCRIPT)).toEqual(["01 | 为什么要读长文", "02 | **算法**与注意力"]);
  });

  it("computeReadingMinutes：中文按字（750/分钟），西文按词（220/分钟），忽略 frontmatter", () => {
    expect(computeReadingMinutes("中".repeat(7500))).toBe(10);
    expect(computeReadingMinutes(`---\ntitle: x\n---\n${"word ".repeat(2200)}`)).toBe(10);
    expect(computeReadingMinutes("短")).toBe(1);
    expect(computeReadingMinutes("")).toBe(0);
  });

  it("condenseForBrief：未超预算原样；超长稿件保留全部标题与每节开头，长度不超预算", () => {
    expect(condenseForBrief(MANUSCRIPT, 10_000)).toBe(MANUSCRIPT);
    const long = Array.from({ length: 12 }, (_, index) => `## ${String(index + 1).padStart(2, "0")} | 第${index + 1}节\n\n${`第${index + 1}节正文。`.repeat(2000)}`).join("\n\n");
    const condensed = condenseForBrief(long, 12_000);
    expect(condensed.length).toBeLessThanOrEqual(12_000);
    for (let index = 1; index <= 12; index += 1) expect(condensed).toContain(`## ${String(index).padStart(2, "0")} | 第${index}节`);
    expect(condensed).toContain("第12节正文。");
  });

  it("buildBriefMessages：按稿件语言选择 prompt，并把真实标题列给模型", () => {
    const [system, user] = buildBriefMessages("## 01 | Intro\n\nHello there.", "en");
    expect(system.content).toBe(BRIEF_SYSTEM_PROMPT_EN);
    expect(user.content).toContain("- 01 | Intro");
    expect(user.content).toContain("Hello there.");
    const [, zh] = buildBriefMessages(MANUSCRIPT, "zh");
    expect(zh.content).toContain("- 02 | **算法**与注意力");
    expect(zh.content).not.toContain("- 📌");
  });
});

describe("frontmatter 嵌入：Store 自描述，正文语义与旧格式不变", () => {
  const episode = { title: "T", podcast_name: "P", published: "", duration: "", audio_url: "", link: "" };
  const now = new Date("2026-05-19T00:00:00Z");
  const brief = normalizeBrief({ ...VALID, tldr: "含 --- 与\n换行与 \"引号\"" }, MANUSCRIPT)!;

  it("无导读时输出与旧格式逐字节一致", () => {
    expect(formatMarkdown(episode, MANUSCRIPT, [], null, now, "UTC", null)).toBe(formatMarkdown(episode, MANUSCRIPT, [], null, now, "UTC"));
    expect(formatMarkdown(episode, MANUSCRIPT, [], null, now, "UTC")).not.toContain("brief:");
  });

  it("有导读时是单行 JSON 值：可解析回同一对象；前端 / 服务端剥离 frontmatter 后正文不变", () => {
    const markdown = formatMarkdown(episode, MANUSCRIPT, [], null, now, "UTC", brief);
    const line = markdown.split("\n").find(row => row.startsWith("brief: "))!;
    expect(JSON.parse(line.slice("brief: ".length))).toEqual(brief);
    const plain = formatMarkdown(episode, MANUSCRIPT, [], null, now, "UTC");
    expect(stripLeadingFrontmatter(markdown)).toBe(stripLeadingFrontmatter(plain));
    // 与 public/js/60-reader.js 的 frontmatter 剥离正则相同
    const readerStrip = (text: string) => text.replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n*/, "");
    expect(readerStrip(markdown)).toBe(readerStrip(plain));
  });
});

// ── generate-brief step：尽力而为 + durable ──

const INSTANCE = processingWorkflowId(TASK, ATTEMPT);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function setup() {
  const cloud = makeCloud();
  insertTask(cloud.d1, { status: "queued" });
  await cloud.workflow.create({ id: INSTANCE, params: paramsFor() });
  globalThis.fetch = cloud.fetch;
  const engine = new DurableStepEngine();
  const run = (step: DurableStepEngine = engine) =>
    runProcessingPipeline(cloud.env, paramsFor(), INSTANCE, step, { fetchFn: cloud.fetch, poll: FAST_POLL });
  return { cloud, engine, run };
}

const storedBrief = (cloud: Cloud) =>
  (cloud.d1.raw.prepare("SELECT brief FROM articles WHERE task_id = ?").get(TASK) as { brief: string | null } | undefined)?.brief ?? null;
const publishedMarkdown = (cloud: Cloud) => [...cloud.externals.files.values()].at(-1) ?? "";

describe("generate-brief step", () => {
  it("在 refine 之后、publish 之前执行；brief 与 article 同 batch 写入 D1，并嵌入成稿 frontmatter", async () => {
    const { cloud, engine, run } = await setup();
    await run();

    const order = engine.executed;
    expect(order.indexOf(REFINE_STEP)).toBeLessThan(order.indexOf(BRIEF_STEP));
    expect(order.indexOf(BRIEF_STEP)).toBeLessThan(order.indexOf(PUBLISH_STEP));
    expect(cloud.externals.briefCalls).toBe(1);
    expect(cloud.externals.llmCalls).toBe(1);
    expect(taskRow(cloud.d1).status).toBe("success");

    const brief = JSON.parse(storedBrief(cloud)!) as ArticleBrief;
    expect(brief).toMatchObject({ version: 1, tldr: BRIEF_RESPONSE.tldr, sections: [{ heading: "01 | 主题", summary: "讨论质量门禁。" }] });
    expect(brief.reading_minutes).toBe(computeReadingMinutes(REFINED_TEXT));
    expect(publishedMarkdown(cloud)).toContain(`brief: ${JSON.stringify(brief)}`);
    // 正文不变
    expect(stripLeadingFrontmatter(publishedMarkdown(cloud))).toContain(REFINED_TEXT.trim());
  });

  it("服务商持续 5xx：有限重试（3 次）后放弃，brief = null，任务照常 success", async () => {
    const { cloud, engine, run } = await setup();
    cloud.externals.briefFailures = [500, 502, 503, 500];
    await run();
    expect(cloud.externals.briefCalls).toBe(3);
    expect(engine.attempts[BRIEF_STEP]).toBe(3);
    expect(taskRow(cloud.d1)).toMatchObject({ status: "success", error_code: null });
    expect(storedBrief(cloud)).toBeNull();
    expect(publishedMarkdown(cloud)).not.toContain("brief:");
  });

  it("瞬时 429 后重试成功", async () => {
    const { cloud, run } = await setup();
    cloud.externals.briefFailures = [429];
    await run();
    expect(cloud.externals.briefCalls).toBe(2);
    expect(storedBrief(cloud)).not.toBeNull();
  });

  it.each([
    ["不可重试的服务商错误（401）", (cloud: Cloud) => void (cloud.externals.briefFailures = [401])],
    ["非 JSON 输出", (cloud: Cloud) => void (cloud.externals.briefContent = "抱歉，我无法完成")],
    ["校验不通过（要点不足）", (cloud: Cloud) => void (cloud.externals.briefContent = JSON.stringify({ ...BRIEF_RESPONSE, key_points: ["一"] }))],
  ])("%s：只调用一次，brief = null，任务照常 success", async (_label, arrange) => {
    const { cloud, run } = await setup();
    arrange(cloud);
    await run();
    expect(cloud.externals.briefCalls).toBe(1);
    expect(taskRow(cloud.d1).status).toBe("success");
    expect(storedBrief(cloud)).toBeNull();
  });

  it("引擎层面耗尽（例如 step 超时）也只降级为 brief = null", async () => {
    const { cloud, engine, run } = await setup();
    engine.injected.set(BRIEF_STEP, [new Error("step timed out"), new Error("step timed out"), new Error("step timed out")]);
    await run();
    expect(taskRow(cloud.d1).status).toBe("success");
    expect(storedBrief(cloud)).toBeNull();
  });

  it("引擎层面耗尽后重放：放弃标记生效，不再调用模型", async () => {
    const { cloud, engine, run } = await setup();
    engine.injected.set(BRIEF_STEP, [new Error("step timed out"), new Error("step timed out"), new Error("step timed out")]);
    engine.crashAfter.add(PUBLISH_STEP);
    await expect(run()).rejects.toThrow();
    expect(engine.executed).toContain(BRIEF_SKIP_STEP);
    const callsBefore = cloud.externals.briefCalls;
    await run(engine.replay());
    expect(cloud.externals.briefCalls).toBe(callsBefore);
    expect(taskRow(cloud.d1).status).toBe("success");
    expect(storedBrief(cloud)).toBeNull();
  });

  it("publish 失败后重放：导读从 checkpoint 复用，不再计费", async () => {
    const { cloud, engine, run } = await setup();
    engine.crashAfter.add(PUBLISH_STEP);
    await expect(run()).rejects.toThrow();
    const replay = engine.replay();
    await run(replay);
    expect(replay.executed).toEqual([PUBLISH_STEP]);
    expect(cloud.externals.briefCalls).toBe(1);
    expect(storedBrief(cloud)).not.toBeNull();
  });

  it("导读期间任务被取消：取消照常传播，不发布", async () => {
    const { cloud, engine, run } = await setup();
    engine.before.set(BRIEF_STEP, () => {
      cloud.d1.raw.prepare("UPDATE tasks SET cancel_requested = 1 WHERE id = ?").run(TASK);
    });
    await expect(run()).rejects.toThrow();
    expect(cloud.externals.briefCalls).toBe(0);
    expect(cloud.externals.github.commits).toBe(0);
    expect(taskRow(cloud.d1).status).toBe("cancelled");
  });

  it("英文稿件使用英文导读 prompt", async () => {
    const { cloud, engine, run } = await setup();
    engine.before.set(BRIEF_STEP, () => {
      cloud.d1.raw.prepare("UPDATE tasks SET content_language = 'en' WHERE id = ?").run(TASK);
    });
    const prompts: string[] = [];
    const inner = cloud.externals.fetch;
    cloud.externals.fetch = async (input, init) => {
      if (String(input).includes("/chat/completions")) prompts.push(JSON.parse(String(init?.body)).messages[0].content);
      return inner(input, init);
    };
    await run();
    expect(prompts).toContain(BRIEF_SYSTEM_PROMPT_EN);
  });
});

describe("persistFinalArticle：articles.brief 与 article upsert 同生共死", () => {
  async function publish(cloud: Cloud, brief: ArticleBrief | null) {
    globalThis.fetch = cloud.fetch;
    return persistFinalArticle(cloud.env, { taskId: TASK, attemptId: ATTEMPT, writingFilename: "20260519_x_y", markdown: MANUSCRIPT, brief });
  }

  it("写入 brief JSON；重新发布（同一单集）用新值覆盖，包括覆盖为 null", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { status: "refining" });
    const brief = normalizeBrief(VALID, MANUSCRIPT)!;
    await publish(cloud, brief);
    expect(JSON.parse(storedBrief(cloud)!)).toEqual(brief);

    cloud.d1.raw.prepare("UPDATE tasks SET status = 'refining' WHERE id = ?").run(TASK);
    await publish(cloud, null);
    expect(storedBrief(cloud)).toBeNull();
  });

  it("导入音频（无 episode_id）的 upsert 分支同样写入 brief", async () => {
    const cloud = makeCloud();
    insertTask(cloud.d1, { status: "refining", source_type: "upload" });
    await publish(cloud, normalizeBrief(VALID, MANUSCRIPT));
    expect(storedBrief(cloud)).not.toBeNull();
  });
});

describe("DTO：brief 是显式白名单字段（对象或 null）", () => {
  const OLD = "22222222-2222-2222-2222-222222222222";
  const call = (cloud: Cloud, path: string) =>
    worker.fetch(new Request(`https://app.test${path}`), cloud.env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);

  function seeded(): Cloud {
    const cloud = makeCloud();
    const db = cloud.d1.raw;
    const insertTaskRow = db.prepare(`INSERT INTO tasks (id, source_type, podcast_name, episode_title, audio_url, status, progress, message, current_attempt_id)
      VALUES (?, 'upload', 'P', ?, 'r2://uploads/x/a.mp3', 'success', 100, '', 'attempt-1')`);
    insertTaskRow.run(TASK, "有导读");
    insertTaskRow.run(OLD, "旧稿件");
    const insertArticle = db.prepare("INSERT INTO articles (task_id, title, podcast_name, content_path, commit_sha, brief) VALUES (?, ?, 'P', ?, 'sha-secret', ?)");
    insertArticle.run(TASK, "有导读", "podcasts/transcripts/secret-path.md", JSON.stringify(normalizeBrief(VALID, MANUSCRIPT)));
    insertArticle.run(OLD, "旧稿件", "podcasts/transcripts/old.md", null);
    return cloud;
  }

  it("GET /api/public/articles/:id：只含阅读元数据与 brief，不含 Store 路径 / commit；旧稿件 brief = null；未知 404", async () => {
    const cloud = seeded();
    const res = await call(cloud, `/api/public/articles/${TASK}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["brief", "created_at", "podcast_name", "task_id", "title", "updated_at"]);
    expect(body.brief).toMatchObject({ version: 1, key_points: VALID.key_points });
    expect(JSON.stringify(body)).not.toMatch(/secret/);

    expect(((await (await call(cloud, `/api/public/articles/${OLD}`)).json()) as Record<string, unknown>).brief).toBeNull();
    expect((await call(cloud, "/api/public/articles/99999999-9999-9999-9999-999999999999")).status).toBe(404);
  });

  it("公共列表保持精简：不带 brief", async () => {
    const cloud = seeded();
    const items = (await (await call(cloud, "/api/public/articles")).json()) as Array<Record<string, unknown>>;
    for (const item of items) expect(item).not.toHaveProperty("brief");
  });

  it("GET /api/control/articles/:id：brief 解析为对象；旧稿件为 null", async () => {
    const cloud = seeded();
    const body = (await (await call(cloud, `/api/control/articles/${TASK}`)).json()) as Record<string, unknown>;
    expect(body.brief).toMatchObject({ version: 1, tldr: "两位主播讨论长文阅读与注意力。" });
    expect(body.content_path).toBe("podcasts/transcripts/secret-path.md");
    const old = (await (await call(cloud, `/api/control/articles/${OLD}`)).json()) as Record<string, unknown>;
    expect(old.brief).toBeNull();
  });
});
