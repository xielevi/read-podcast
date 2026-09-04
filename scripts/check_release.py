#!/usr/bin/env python3
"""发布一致性门禁：版本号、tag、App 元数据、发布物命名必须指向同一个版本。

用法：
    scripts/check_release.py                # 发布前完整检查
    scripts/check_release.py --version-only # 只校验版本号格式（CI 每次跑）
    scripts/check_release.py --dist dist    # 附带校验 dist/ 里的发布物
"""
from __future__ import annotations

import argparse
import hashlib
import plistlib
import re
import subprocess
import sys
import tomllib
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
APP_NAME = "Read Podcast"
# 正式版与预发布（v1.0.0-rc.1）都允许；只有正式版才该移动 latest / stable。
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(-(?:rc|beta|alpha)\.\d+)?$")

problems: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=PROJECT_ROOT, capture_output=True, text=True
    ).stdout.strip()


def read_version() -> str:
    with (PROJECT_ROOT / "pyproject.toml").open("rb") as fh:
        return tomllib.load(fh)["project"]["version"]


def check_tag(version: str) -> None:
    """HEAD 必须正好落在 v<version> 上，避免 tag 和产物版本对不上。"""
    if git("status", "--porcelain"):
        fail("工作区不干净，发布必须从干净的工作树构建。")
    tag = git("describe", "--exact-match", "--tags", "HEAD")
    if not tag:
        fail(f"HEAD 上没有 tag，发布前请先打 v{version}。")
    elif tag != f"v{version}":
        fail(f"tag 与 pyproject.toml 不一致：tag={tag}，version={version}。")


def check_dist(version: str, dist: Path) -> None:
    dmg = dist / f"{APP_NAME}-{version}.dmg"
    if not dmg.exists():
        fail(f"缺少发布物 {dmg.name}（dist 里的 DMG 必须带当前版本号）。")
        return

    sha_file = dmg.with_suffix(".dmg.sha256")
    if not sha_file.exists():
        fail(f"缺少 {sha_file.name}，发布必须同时提供 SHA256。")
    else:
        recorded = sha_file.read_text().split()[0]
        actual = hashlib.sha256(dmg.read_bytes()).hexdigest()
        if recorded != actual:
            fail(f"{sha_file.name} 与 DMG 实际校验和不一致，产物可能已被改动。")

    plist_path = dist / f"{APP_NAME}.app" / "Contents" / "Info.plist"
    if not plist_path.exists():
        fail(f"缺少 {plist_path.relative_to(PROJECT_ROOT)}，无法核对 App 版本。")
        return
    with plist_path.open("rb") as fh:
        short = plistlib.load(fh).get("CFBundleShortVersionString")
    if short != version:
        fail(f"CFBundleShortVersionString={short}，与 pyproject.toml 的 {version} 不一致。")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version-only", action="store_true", help="只校验版本号格式")
    parser.add_argument("--dist", type=Path, help="附带校验该目录下的发布物")
    args = parser.parse_args()

    version = read_version()
    if not VERSION_RE.match(version):
        fail(f"pyproject.toml 的 version={version!r} 不是合法的发布版本号。")

    if not args.version_only:
        check_tag(version)
        if args.dist:
            check_dist(version, args.dist if args.dist.is_absolute() else PROJECT_ROOT / args.dist)

    if problems:
        print(f"✗ 发布一致性检查未通过（version={version}）：", file=sys.stderr)
        for item in problems:
            print(f"  - {item}", file=sys.stderr)
        return 1
    print(f"✓ 发布一致性检查通过（version={version}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
