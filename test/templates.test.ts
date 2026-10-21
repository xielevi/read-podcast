import { describe, expect, it } from "vitest";
import { listPromptTemplates, PROMPT_TEMPLATES } from "../src/templates";

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
});
