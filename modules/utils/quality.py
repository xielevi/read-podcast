import re

RE_WHITESPACE = re.compile(r"\s+")
QUALITY_FEATURE_PATTERNS = {
    "has_header": re.compile(r"^#+\s+.+", re.MULTILINE),
    "has_bold": re.compile(r"\*\*.+\*\*", re.MULTILINE),
    "has_speaker": re.compile(r"^(?:说话人|主持人|嘉宾|主播|.+[：:])\s*.+", re.MULTILINE),
    "has_outline": re.compile(r"节目大纲|时间线|📌", re.MULTILINE),
}


def count_meaningful_chars(text):
    """统计非空白字符数，用于判断精修稿是否被过度压缩。"""
    return len(RE_WHITESPACE.sub("", text or ""))


def verify_refinement_quality(md_content, raw_text_sample=None, min_output_ratio=0.9):
    """检查精修稿的 Markdown 特征和长度门禁。"""
    matched = []
    score = 0
    sample_content = md_content[:5000]
    for name, pattern in QUALITY_FEATURE_PATTERNS.items():
        if pattern.search(sample_content):
            matched.append(name)
            score += 1

    if raw_text_sample:
        raw_chars = count_meaningful_chars(raw_text_sample)
        output_chars = count_meaningful_chars(md_content)
        ratio = output_chars / raw_chars if raw_chars else 1
        if ratio >= min_output_ratio:
            matched.append(f"length_ratio:{ratio:.2f}")
        else:
            matched.append(f"too_short:{ratio:.2f}")
            score -= 2

    return score >= 2, score, matched
