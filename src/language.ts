/**
 * 播客内容语言归一与轻量本地检测。
 *
 * 规范：
 * - zh: zh, zh-CN, zh-TW, zh-HK, zh-SG, cmn, mandarin, chinese 等；
 * - en: en, en-US, en-GB, en-AU, en-CA, english 等。
 *
 * 当 Provider 语言元数据缺失（如恢复重试旧 raw）时，基于字符集比例进行确定性本地识别，
 * 不新增外部 LLM 调用。
 */

export type ContentLanguage = "zh" | "en";

export function normalizeContentLanguage(lang?: string | null): ContentLanguage | null {
  if (!lang) return null;
  const trimmed = lang.trim().toLowerCase();
  if (!trimmed) return null;

  if (
    trimmed === "zh" ||
    trimmed.startsWith("zh-") ||
    trimmed.startsWith("zh_") ||
    trimmed === "cmn" ||
    trimmed === "mandarin" ||
    trimmed === "chinese"
  ) {
    return "zh";
  }

  if (
    trimmed === "en" ||
    trimmed.startsWith("en-") ||
    trimmed.startsWith("en_") ||
    trimmed === "english"
  ) {
    return "en";
  }

  return null;
}

export function detectLanguageFromText(text: string): ContentLanguage {
  const sample = (text ?? "").slice(0, 20000);
  let cjkCount = 0;
  let latinCount = 0;

  for (const char of sample) {
    const code = char.codePointAt(0) || 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjkCount++;
    } else if (
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a)
    ) {
      latinCount++;
    }
  }

  if (cjkCount >= 20 || (cjkCount > 0 && cjkCount >= latinCount * 0.1)) {
    return "zh";
  }

  if (latinCount >= 20) {
    return "en";
  }

  return "zh";
}

export function resolveContentLanguage(
  providerLang?: string | null,
  envHint?: string | null,
  rawText?: string | null,
): ContentLanguage {
  const fromProvider = normalizeContentLanguage(providerLang);
  if (fromProvider) return fromProvider;

  const fromEnv = normalizeContentLanguage(envHint);
  if (fromEnv) return fromEnv;

  if (rawText && rawText.trim()) {
    return detectLanguageFromText(rawText);
  }

  return "zh";
}
