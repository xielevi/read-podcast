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
});
