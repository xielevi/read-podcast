import logging
import re
import yaml

RE_NAMES_SPLIT = re.compile(r"[、，,\s/&及与]+")


def extract_frontmatter(md_content):
    match = re.search(r"^---\s*\n(.*?)\n---\s*\n", md_content, re.DOTALL)
    if match:
        try:
            return yaml.safe_load(match.group(1)), match.group(0)
        except Exception as exc:
            logging.error("解析 Frontmatter 失败: %s", exc)
    return None, None


def extract_metadata_from_text(title, summary):
    context = (title + "\n" + summary[:1000]).replace("\r", "")
    host_patterns = [
        re.compile(r"(?:主播|主持人|主讲人|Host)[：（\s]*([^｜|\n\s]+(?:、[^｜|\n\s]+)*)"),
        re.compile(r"(?:主播|主持人|主讲人|Host)\s*\|\s*([^｜|\n\s]+)"),
        re.compile(r"(?:主播|主持人|主讲人|Host)\s*[:：]\s*([^\s]+)"),
    ]
    guest_patterns = [
        re.compile(r"(?:嘉宾|对话|访谈|对谈|Guest)[：（\s]*([^｜|\n\s]+(?:、[^｜|\n\s]+)*)"),
        re.compile(r"(?:嘉宾|对话|访谈|对谈|Guest)\s*\|\s*([^｜|\n\s]+)"),
        re.compile(r"(?:嘉宾|对话|访谈|对谈|Guest)\s*[:：]\s*([^\s]+)"),
    ]

    def clean_list(raw):
        return [name.strip() for name in RE_NAMES_SPLIT.split(raw or "") if name.strip() and len(name.strip()) > 1]

    metadata = {"hosts": [], "guests": []}
    for pattern in host_patterns:
        match = pattern.search(context)
        if match:
            metadata["hosts"].extend(clean_list(match.group(1)))
            break
    for pattern in guest_patterns:
        match = pattern.search(context)
        if match:
            metadata["guests"].extend(clean_list(match.group(1)))
            break
    metadata["hosts"] = list(set(metadata["hosts"]))
    metadata["guests"] = list(set(metadata["guests"]))
    return metadata
