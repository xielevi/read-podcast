import { describe, expect, it } from "vitest";
import { listPromptTemplates, matchTemplateLanguage, PROMPT_TEMPLATES } from "../src/templates";
import { buildRefinePrompt } from "../src/refinement/refiner";
import { DEFAULT_REFINE_PROMPT, DEFAULT_REFINE_PROMPT_EN } from "../src/refinement/defaults";

describe("Prompt Templates", () => {
  it("returns approved edge-owned templates with consistent editorial targets", () => {
    const res = listPromptTemplates();
    expect(res.status).toBe(200);
    expect(PROMPT_TEMPLATES).toHaveLength(3);

    const ids = PROMPT_TEMPLATES.map(t => t.id);
    expect(ids).toEqual(["magazine", "clean_verbatim", "structured_interview"]);

    for (const t of PROMPT_TEMPLATES) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.content).toBeTruthy();
    }
    expect(PROMPT_TEMPLATES[0].content).toContain("75%–85%");
    expect(PROMPT_TEMPLATES[1].content).toContain("90%");
  });

  it("ships an English version of every template for English-language users", () => {
    for (const t of PROMPT_TEMPLATES) {
      expect(t.content_en, t.id).toBeTruthy();
      expect(/[\u4e00-\u9fff]/.test(t.content_en), t.id).toBe(false);
    }
    expect(PROMPT_TEMPLATES[0].content_en).toContain("75%–85%");
    expect(PROMPT_TEMPLATES[1].content_en).toContain("90%");
    expect(PROMPT_TEMPLATES[2].content_en).toContain("## 01 | Topic");
  });

  it("swaps a built-in template to the transcript's language and keeps the user's additions", () => {
    const tpl = PROMPT_TEMPLATES.find(t => t.id === "structured_interview")!;
    expect(matchTemplateLanguage(tpl.content.trim(), "en")).toBe(tpl.content_en.trim());
    expect(matchTemplateLanguage(`${tpl.content.trim()}\n\n人名统一写英文。`, "en")).toBe(`${tpl.content_en.trim()}\n\n人名统一写英文。`);
    expect(matchTemplateLanguage(tpl.content_en.trim(), "zh")).toBe(tpl.content.trim());
    expect(matchTemplateLanguage(tpl.content.trim(), "zh")).toBe(tpl.content.trim());
    expect(matchTemplateLanguage("Keep the Q&A format.", "zh")).toBe("Keep the Q&A format.");
  });

  it("buildRefinePrompt sends English audio the English template even when the Chinese one was chosen", () => {
    for (const t of PROMPT_TEMPLATES) {
      const en = buildRefinePrompt("Show notes", t.content, DEFAULT_REFINE_PROMPT_EN);
      expect(/[\u4e00-\u9fff]/.test(en), t.id).toBe(false);
      const zh = buildRefinePrompt("简介", t.content_en, DEFAULT_REFINE_PROMPT);
      expect(zh.startsWith(t.content.trim().slice(0, 20)), t.id).toBe(true);
    }
  });
});
