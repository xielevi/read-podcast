import { describe, expect, it } from "vitest";
import {
  detectLanguageFromText,
  normalizeContentLanguage,
  resolveContentLanguage,
} from "../src/language";

describe("language normalization & detection", () => {
  it("normalizes Chinese language tags correctly", () => {
    expect(normalizeContentLanguage("zh")).toBe("zh");
    expect(normalizeContentLanguage("zh-CN")).toBe("zh");
    expect(normalizeContentLanguage("zh-TW")).toBe("zh");
    expect(normalizeContentLanguage("zh-HK")).toBe("zh");
    expect(normalizeContentLanguage("cmn")).toBe("zh");
    expect(normalizeContentLanguage("mandarin")).toBe("zh");
    expect(normalizeContentLanguage("chinese")).toBe("zh");
  });

  it("normalizes English language tags correctly", () => {
    expect(normalizeContentLanguage("en")).toBe("en");
    expect(normalizeContentLanguage("en-US")).toBe("en");
    expect(normalizeContentLanguage("en-GB")).toBe("en");
    expect(normalizeContentLanguage("en-AU")).toBe("en");
    expect(normalizeContentLanguage("english")).toBe("en");
  });

  it("returns null for unknown, empty, or unsupported languages", () => {
    expect(normalizeContentLanguage("")).toBeNull();
    expect(normalizeContentLanguage(null)).toBeNull();
    expect(normalizeContentLanguage(undefined)).toBeNull();
    expect(normalizeContentLanguage("fr")).toBeNull();
    expect(normalizeContentLanguage("ja")).toBeNull();
  });

  it("detects Chinese from predominantly CJK text", () => {
    const zhText = "这是一段测试文字。今天我们讨论人工智能和科学计算的发展历程。";
    expect(detectLanguageFromText(zhText)).toBe("zh");
  });

  it("detects English from predominantly Latin text", () => {
    const enText = "This is a podcast about technology and artificial intelligence. Welcome Derek Thompson to the show.";
    expect(detectLanguageFromText(enText)).toBe("en");
  });

  it("resolves language in priority: provider > env hint > raw text fallback", () => {
    expect(resolveContentLanguage("en-US", "zh-CN", "中文正文")).toBe("en");
    expect(resolveContentLanguage(null, "en-GB", "中文正文")).toBe("en");
    expect(resolveContentLanguage(null, null, "Hello everyone, welcome back to the Ezra Klein show.")).toBe("en");
    expect(resolveContentLanguage(null, null, "大家好，欢迎收听今天的节目。")).toBe("zh");
  });

  it("keeps long English transcripts English even when they mention a few Chinese names", () => {
    const names = "孔子 老子 庄子 孟子 荀子 韩非子 墨子 鲁迅 王阳明 朱熹 ";
    const english = `${"We talked about markets, history and philosophy for a long while. ".repeat(80)}${names}`;
    expect(names.replace(/\s/g, "").length).toBeGreaterThanOrEqual(20);
    expect(detectLanguageFromText(english)).toBe("en");
  });

  it("keeps Chinese transcripts with heavy English terminology Chinese", () => {
    const mixed = "今天我们聊 AI agent、LLM inference 和 GPU cluster 的成本结构，以及 open source 社区的变化。".repeat(20);
    expect(detectLanguageFromText(mixed)).toBe("zh");
  });
});
