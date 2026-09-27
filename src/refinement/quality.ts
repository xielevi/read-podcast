/**
 * 精修质量门禁（行为迁移自 mac_worker/core/quality.py，Edge 独立维护）。
 *
 * 保持 O(n) 轻量实现：仅正则扫描前 5000 字符 + 非空白字符计数。
 * 不引入重型 Markdown / YAML parser，确保在 Workflows Free CPU 限制内完成。
 */

export const QUALITY_FEATURE_PATTERNS: Record<string, RegExp> = {
  has_header: /^#+\s+.+/m,
  has_bold: /\*\*.+\*\*/m,
  has_speaker: /^(?:说话人|主持人|嘉宾|主播|.+[：:])\s*.+/m,
  has_outline: /节目大纲|时间线|📌|outline|timeline/im,
};

/** 统计非空白字符数，用于判断精修稿是否被过度压缩。 */
export function countMeaningfulChars(text: string): number {
  return (text ?? "").replace(/\s+/g, "").length;
}

export interface QualityResult {
  valid: boolean;
  score: number;
  features: string[];
}

/**
 * 检查精修稿的 Markdown 特征和长度门禁。
 * 特征扫描只看前 5000 字符（与原实现一致）；长度门禁对比精修稿与原始转录的非空白字符数。
 * 长度是硬门槛：结构特征再齐全，也不能抵消过短（被摘要化）的精修稿。
 */
export function verifyRefinementQuality(
  mdContent: string,
  rawTextSample: string | null = null,
  minOutputRatio = 0.7,
): QualityResult {
  const matched: string[] = [];
  let score = 0;
  let lengthOk = true;
  const sampleContent = (mdContent ?? "").slice(0, 5000);

  for (const [name, pattern] of Object.entries(QUALITY_FEATURE_PATTERNS)) {
    if (pattern.test(sampleContent)) {
      matched.push(name);
      score += 1;
    }
  }

  if (rawTextSample) {
    const rawChars = countMeaningfulChars(rawTextSample);
    const outputChars = countMeaningfulChars(mdContent ?? "");
    const ratio = rawChars ? outputChars / rawChars : 1;
    if (ratio >= minOutputRatio) {
      matched.push(`length_ratio:${ratio.toFixed(2)}`);
    } else {
      matched.push(`too_short:${ratio.toFixed(2)}`);
      lengthOk = false;
      score -= 2;
    }
  }

  return { valid: lengthOk && score >= 2, score, features: matched };
}
