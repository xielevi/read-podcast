#!/usr/bin/env python3
"""把 app/static/js/ 下的前端源码分片拼接成运行时实际加载的 app/static/app.js。

前端是一份无构建工具的经典脚本（全局作用域，非 ES module）。为便于维护，源码按
业务域拆分到 ``app/static/js/NN-*.js``，本脚本按文件名顺序原样拼接生成 ``app.js``。
拼接是纯字节拼接：生成物与分片逐字节对应，运行时行为与拆分前完全一致。

用法：
    python scripts/build_frontend.py           # 生成/更新 app/static/app.js
    python scripts/build_frontend.py --check    # 只校验 app.js 与分片一致（CI 用）
"""
from __future__ import annotations

import sys
from pathlib import Path

STATIC_DIR = Path(__file__).resolve().parent.parent / "app" / "static"
FRAGMENTS_DIR = STATIC_DIR / "js"
BUNDLE = STATIC_DIR / "app.js"


def _assemble() -> str:
    fragments = sorted(FRAGMENTS_DIR.glob("*.js"))
    if not fragments:
        raise SystemExit(f"没有找到前端分片：{FRAGMENTS_DIR}")
    return "".join(f.read_text(encoding="utf-8") for f in fragments)


def main(argv: list[str]) -> int:
    check_only = "--check" in argv[1:]
    assembled = _assemble()
    if check_only:
        current = BUNDLE.read_text(encoding="utf-8") if BUNDLE.exists() else ""
        if current != assembled:
            print(
                "app/static/app.js 与 app/static/js/ 分片不一致。\n"
                "请运行 `python scripts/build_frontend.py` 重新生成后再提交。",
                file=sys.stderr,
            )
            return 1
        print("app.js 与分片一致。")
        return 0
    BUNDLE.write_text(assembled, encoding="utf-8")
    nbytes = len(assembled.encode("utf-8"))
    print(f"已生成 {BUNDLE}（{nbytes} 字节，来自 {FRAGMENTS_DIR.name}/ 分片）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
