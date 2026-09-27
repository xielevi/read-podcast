"""文件名安全收敛（最小 filesystem-safe helper）。

``build_filename_base`` 已迁至 Cloudflare Edge（``src/refinement/naming.ts``），
正式稿文件名由 Edge 决定；本模块只保留本地临时文件（下载/转录缓存）必需的
sanitizer，绝不参与正式稿命名。
"""
from __future__ import annotations

import hashlib
import re

_UNSAFE_COMPONENT_CHARS = re.compile(r"[/\\\x00-\x1f\x7f]+")


def safe_storage_component(value: str, *, fallback: str = "item") -> str:
    """把不可信显示文本收敛成一个确定的文件系统分量。

    安全名保持字节兼容既有缓存；只替换路径分隔符与控制字符，必要时追加短摘要，
    避免两个不同的不安全名坍缩到同一文件。
    """
    raw = str(value or "").strip()
    cleaned = _UNSAFE_COMPONENT_CHARS.sub("_", raw)
    changed = cleaned != raw
    if not cleaned or cleaned in {".", ".."}:
        cleaned = fallback
        changed = True
    if changed:
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:10]
        cleaned = f"{cleaned.rstrip(' ._') or fallback}-{digest}"
    return cleaned
