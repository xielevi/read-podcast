"""
测试 OpenAI 兼容精修引擎的质量门禁逻辑。
"""
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from modules.refiner import OpenaiCompatRefiner
from modules.utils import verify_refinement_quality


class FakeRefiner(OpenaiCompatRefiner):
    """绕过真实 HTTP 调用的测试用精修器。"""

    def __init__(self, responses):
        # 跳过父类 __init__ 中的网络配置
        self.api_base = "http://fake/v1"
        self.model = "fake-model"
        self.max_tokens = 65536
        self.temperature = 0.3
        self.max_retries = 3
        self.api_key = "fake-key"
        self._chat_url = "http://fake/v1/chat/completions"
        self.responses = list(responses)

    def call(self, prompt, text_content, progress_callback=None):
        if not self.responses:
            return None
        return self.responses.pop(0)


def test_refiner_returns_markdown_output():
    """精修器正常返回 Markdown 文本时，应正确提取。"""
    raw_text = "这是原始转录文本。" * 100
    refined = "## 话题标题\n\n**主持人**：整理后的发言。\n\n**嘉宾**：这是精修稿。" + ("内容" * 100)
    refiner = FakeRefiner([refined])

    result = refiner.call("精修指令", raw_text)

    assert result is not None
    assert "## 话题标题" in result
    assert "**主持人**" in result


def test_refiner_returns_none_when_no_response():
    """精修器无响应时应返回 None。"""
    refiner = FakeRefiner([])
    result = refiner.call("精修指令", "原始文本")
    assert result is None


def test_quality_check_rejects_over_compressed_output():
    """质量门禁应拒绝过度压缩的精修稿。"""
    raw_text = "这是很长的原始转录文本。" * 500
    short_output = "## 摘要\n\n主持人：这是很短的总结。"

    is_valid, score, features = verify_refinement_quality(
        short_output,
        raw_text_sample=raw_text,
        min_output_ratio=0.9,
    )

    assert not is_valid
    assert score < 2
    assert any(item.startswith("too_short:") for item in features)


def test_quality_check_accepts_well_structured_output():
    """质量门禁应通过结构良好且长度达标的精修稿。"""
    raw_text = "内容" * 1000  # 2000 非空白字符
    # 精修稿保留 95% 以上长度，且有标题/加粗/说话人标注
    long_output = "## 标题\n\n**主持人**：发言。\n" + "内容" * 950

    is_valid, score, features = verify_refinement_quality(
        long_output,
        raw_text_sample=raw_text,
        min_output_ratio=0.9,
    )

    assert is_valid
    assert score >= 2
    assert any(item.startswith("length_ratio:") for item in features)
