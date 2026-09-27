import { describe, expect, it } from "vitest";
import {
  DEFAULT_REFINE_PROMPT,
  DEFAULT_REFINE_PROMPT_EN,
  REFINER_SYSTEM_PROMPT,
  REFINER_SYSTEM_PROMPT_EN,
} from "../src/refinement/defaults";
import { buildRefineMessages, buildRefinePrompt } from "../src/refinement/refiner";
import { QUALITY_FEATURE_PATTERNS, verifyRefinementQuality } from "../src/refinement/quality";
import { CONCEPTS_SYSTEM_PROMPT, CONCEPTS_SYSTEM_PROMPT_EN } from "../src/refinement/concepts";
import {
  detectLanguageFromText,
  normalizeContentLanguage,
  resolveContentLanguage,
} from "../src/language";
import { parseUiPreferencesPatch } from "../src/preferences";

describe("i18n & Bilingual Editorial Pipeline", () => {
  describe("Automatic Editorial Prompt Selection", () => {
    it("selects Chinese default prompt and system prompt for Chinese tasks", () => {
      const contentLang: string = "zh";
      const prompt = buildRefinePrompt(
        "本期播客讨论了科技发展与人文思考。",
        null,
        contentLang === "en" ? DEFAULT_REFINE_PROMPT_EN : DEFAULT_REFINE_PROMPT
      );
      expect(prompt).toContain("节目大纲与时间线");
      expect(prompt).toContain("本期播客讨论了科技发展与人文思考。");

      const systemPrompt = contentLang === "en" ? REFINER_SYSTEM_PROMPT_EN : REFINER_SYSTEM_PROMPT;
      expect(systemPrompt).toBe(REFINER_SYSTEM_PROMPT);
      expect(systemPrompt).toContain("专业的播客文字整理者");

      const messages = buildRefineMessages(prompt, "这是音频转写文本", systemPrompt);
      expect(messages[0].content).toBe(REFINER_SYSTEM_PROMPT);
      expect(messages[1].content).toContain("节目大纲与时间线");
      expect(messages[1].content).toContain("这是音频转写文本");
    });

    it("selects English default prompt and system prompt for English tasks", () => {
      const contentLang: string = "en";
      const prompt = buildRefinePrompt(
        "A deep discussion on technology and philosophy.",
        null,
        contentLang === "en" ? DEFAULT_REFINE_PROMPT_EN : DEFAULT_REFINE_PROMPT
      );
      expect(prompt).toContain("Outline & Timeline");
      expect(prompt).toContain("A deep discussion on technology and philosophy.");
      expect(prompt).toContain("Output Format");

      const systemPrompt = contentLang === "en" ? REFINER_SYSTEM_PROMPT_EN : REFINER_SYSTEM_PROMPT;
      expect(systemPrompt).toBe(REFINER_SYSTEM_PROMPT_EN);
      expect(systemPrompt).toContain("professional podcast transcript editor");

      const messages = buildRefineMessages(prompt, "This is transcript text", systemPrompt);
      expect(messages[0].content).toBe(REFINER_SYSTEM_PROMPT_EN);
      expect(messages[1].content).toContain("Outline & Timeline");
      expect(messages[1].content).toContain("This is transcript text");
    });

    it("custom prompt takes highest precedence over language-specific defaults", () => {
      const customPrompt = "Please summarize this conversation into 5 key bullet points: {summary}";
      
      const promptZh = buildRefinePrompt(
        "简介内容",
        customPrompt,
        DEFAULT_REFINE_PROMPT
      );
      expect(promptZh).toBe("Please summarize this conversation into 5 key bullet points: 简介内容");

      const promptEn = buildRefinePrompt(
        "Show notes",
        customPrompt,
        DEFAULT_REFINE_PROMPT_EN
      );
      expect(promptEn).toBe("Please summarize this conversation into 5 key bullet points: Show notes");
    });
  });

  describe("Quality Gate Bilingual Outline Validation", () => {
    it("accepts Chinese outline patterns", () => {
      expect(QUALITY_FEATURE_PATTERNS.has_outline.test("### 📌 节目大纲与时间线\n- 00:01 介绍")).toBe(true);
      expect(QUALITY_FEATURE_PATTERNS.has_outline.test("## 时间线\n- 01:23 话题一")).toBe(true);
      expect(QUALITY_FEATURE_PATTERNS.has_outline.test("## 节目大纲\n- 02:45 话题二")).toBe(true);
    });

    it("accepts English outline and timeline patterns", () => {
      expect(QUALITY_FEATURE_PATTERNS.has_outline.test("### Outline & Timeline\n- 00:01 Introduction")).toBe(true);
      expect(QUALITY_FEATURE_PATTERNS.has_outline.test("## Episode Outline\n- 01:23 Topic One")).toBe(true);
      expect(QUALITY_FEATURE_PATTERNS.has_outline.test("## Timeline\n- 02:45 Topic Two")).toBe(true);
      expect(QUALITY_FEATURE_PATTERNS.has_outline.test("### 📌 Outline\n- 03:00 Topic Three")).toBe(true);
    });

    it("verifies refinement quality passes for a valid English manuscript", () => {
      const raw = "word ".repeat(300);
      const markdown = `---
title: Test Episode
---

### Outline & Timeline
- **00:01** Intro
- **05:00** Deep Dive

---

## 01 | Section One
${"This is high quality refined content. ".repeat(40)}

## 02 | Section Two
${"Another section of substantive content. ".repeat(40)}
`;
      const result = verifyRefinementQuality(markdown, raw, 0.1);
      expect(result.valid).toBe(true);
    });
  });

  describe("Concepts System Prompt Localization", () => {
    it("provides distinct Chinese and English concept extraction instructions", () => {
      expect(CONCEPTS_SYSTEM_PROMPT).toContain("维基百科");
      expect(CONCEPTS_SYSTEM_PROMPT).toContain("独立条目");
      
      expect(CONCEPTS_SYSTEM_PROMPT_EN).toContain("Wikipedia");
      expect(CONCEPTS_SYSTEM_PROMPT_EN).toContain("Standalone entries");
      expect(CONCEPTS_SYSTEM_PROMPT_EN).toContain("JSON object");
    });
  });

  describe("Preferences & Locale Invariants", () => {
    it("validates locale in preferences patch", () => {
      expect(parseUiPreferencesPatch({ locale: "en" }).locale).toBe("en");
      expect(parseUiPreferencesPatch({ locale: "zh" }).locale).toBe("zh");
      expect(() => parseUiPreferencesPatch({ locale: "fr" })).toThrow();
    });
  });
});
