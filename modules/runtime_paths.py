"""Stable code and writable-data locations shared by every runtime mode."""
from __future__ import annotations

import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent


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
