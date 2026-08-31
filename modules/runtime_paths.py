"""Stable code and writable-data locations shared by every runtime mode."""
from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent

_UNSAFE_COMPONENT_CHARS = re.compile(r"[/\\\\\x00-\x1f\x7f]+")


def runtime_data_dir() -> Path:
    """Return the writable workspace root without coupling it to the code bundle."""
    configured = os.getenv(
        "READ_PODCAST_DATA_DIR",
        os.getenv("PODCAST2MD_DATA_DIR", ""),
    ).strip()
    if configured:
        candidate = Path(configured).expanduser()
        return candidate if candidate.is_absolute() else (PROJECT_ROOT / candidate).absolute()
    return PROJECT_ROOT / "workspace"


def resolve_runtime_path(path: str | Path, *, data_dir: Path | None = None) -> Path:
    """Resolve legacy ``workspace/...`` paths against the writable data root.

    Other relative paths retain their historical project-root semantics.
    """
    candidate = Path(path).expanduser()
    if candidate.is_absolute():
        return candidate
    if candidate.parts and candidate.parts[0] == "workspace":
        root = data_dir or runtime_data_dir()
        return root.joinpath(*candidate.parts[1:]).absolute()
    return (PROJECT_ROOT / candidate).absolute()


def safe_storage_component(value: str, *, fallback: str = "item") -> str:
    """Return one deterministic filesystem component for untrusted display text.

    Safe names remain byte-for-byte compatible with existing caches. Only path
    separators and control characters are replaced; a short digest prevents two
    different unsafe names from collapsing onto the same stored artifact.
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
