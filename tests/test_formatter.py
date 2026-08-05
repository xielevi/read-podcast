import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from modules.formatter import Formatter, strip_leading_frontmatter


def test_strip_leading_frontmatter_removes_model_metadata():
    text = "---\ntitle: 模型误吐标题\n---\n\n## 正文\n\n内容"

    assert strip_leading_frontmatter(text) == "## 正文\n\n内容"


def test_format_markdown_keeps_single_frontmatter(tmp_path):
    formatter = Formatter()
    episode = {
        "title": "节目标题",
        "podcast_name": "测试播客",
        "published": "2026-06-15",
        "duration": "01:00:00",
        "audio_url": "https://example.com/audio.mp3",
        "link": "https://example.com/episode",
    }
    transcript = "---\ntitle: 模型误吐标题\n---\n\n## 正文\n\n内容"

    markdown = formatter.format_markdown(
        episode,
        transcript,
        processing={
            "refinement_success": False,
            "transcript_source": "raw_fallback",
        },
    )

    assert markdown.count("---") == 3
    assert "模型误吐标题" not in markdown
    assert "refinement_success: false" in markdown
    assert "transcript_source: raw_fallback" in markdown
    assert "## 正文" in markdown
