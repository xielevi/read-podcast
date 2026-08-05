import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from modules.utils import verify_refinement_quality


def test_refinement_quality_rejects_over_compressed_output():
    raw_text = "原始内容" * 1000
    short_markdown = "## 摘要\n\n主持人：这是一个很短的总结。"

    is_valid, score, features = verify_refinement_quality(
        short_markdown,
        raw_text_sample=raw_text,
        min_output_ratio=0.9,
    )

    assert not is_valid
    assert score < 2
    assert any(item.startswith("too_short:") for item in features)


def test_refinement_quality_accepts_structured_output_with_enough_length():
    raw_text = "原始内容" * 1000
    long_markdown = "## 第一部分\n\n主持人：这是保留细节的精修文本。" + ("原始内容" * 920)

    is_valid, score, features = verify_refinement_quality(
        long_markdown,
        raw_text_sample=raw_text,
        min_output_ratio=0.9,
    )

    assert is_valid
    assert score >= 2
    assert any(item.startswith("length_ratio:") for item in features)
