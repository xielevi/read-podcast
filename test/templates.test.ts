import { describe, expect, it } from "vitest";
import { listPromptTemplates, PROMPT_TEMPLATES } from "../src/templates";

describe("Prompt Templates", () => {
  it("returns exactly the 3 approved edge-owned templates with 90%+ length invariant", () => {
    const res = listPromptTemplates();
    expect(res.status).toBe(200);
    expect(PROMPT_TEMPLATES).toHaveLength(3);

    const ids = PROMPT_TEMPLATES.map(t => t.id);
    expect(ids).toEqual(["magazine", "clean_verbatim", "structured_interview"]);

    for (const t of PROMPT_TEMPLATES) {
      expect(t.content).toContain("90%");
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
    }
  });
});
