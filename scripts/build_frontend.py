#!/usr/bin/env python3
"""把 public/js/ 下的前端分片按文件名顺序逐字节拼接成运行时加载的 public/app.js。

前端是一份无构建工具的经典脚本（全局作用域，非 ES module）。源码按业务域拆分到
``public/js/NN-*.js``；本脚本纯字节拼接，生成物与分片逐字节对应。

``'use strict'`` 只由本脚本写在 bundle 第一行：指令只有位于脚本开头（directive prologue）
才生效，写在任何分片里都会随拼接顺序落到中间而静默失效，因此分片中一律禁止出现。

用法：
    python scripts/build_frontend.py           # 生成/更新 public/app.js
    python scripts/build_frontend.py --check    # 只校验一致（CI 用）
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

PUBLIC_DIR = Path(__file__).resolve().parent.parent / "public"
FRAGMENTS_DIR = PUBLIC_DIR / "js"
BUNDLE = PUBLIC_DIR / "app.js"
STRICT_HEADER = "'use strict';\n"
STRICT_DIRECTIVE = re.compile(r"^\s*['\"]use strict['\"];?\s*$", re.MULTILINE)


def _check_syntax(file_path: Path) -> None:
    res = subprocess.run(["node", "--check", str(file_path)], capture_output=True, text=True)
    if res.returncode != 0:
        print(f"JavaScript 语法检查失败: {file_path}\n{res.stderr}", file=sys.stderr)
        raise SystemExit(1)


def _assemble() -> str:
    fragments = sorted(FRAGMENTS_DIR.glob("*.js"))
    if not fragments:
        raise SystemExit(f"没有找到前端分片：{FRAGMENTS_DIR}")
    for fragment in fragments:
        _check_syntax(fragment)
        if STRICT_DIRECTIVE.search(fragment.read_text(encoding="utf-8")):
            print(f"{fragment} 含有 'use strict'：它只能由 bundle 开头统一提供。", file=sys.stderr)
            raise SystemExit(1)
    return STRICT_HEADER + "".join(f.read_text(encoding="utf-8") for f in fragments)


def main(argv: list[str]) -> int:
    check_only = "--check" in argv[1:]
    assembled = _assemble()
    if check_only:
        if not BUNDLE.exists():
            print(f"没有找到 {BUNDLE}，请运行 `python scripts/build_frontend.py` 生成。", file=sys.stderr)
            return 1
        _check_syntax(BUNDLE)
        current = BUNDLE.read_text(encoding="utf-8")
        if current != assembled:
            print(
                "public/app.js 与 public/js/ 分片不一致。\n"
                "请运行 `python scripts/build_frontend.py` 重新生成后再提交。",
                file=sys.stderr,
            )
            return 1
        print("app.js 与分片一致，且所有分片与 bundle 均通过 node --check 语法校验。")
        return 0
    BUNDLE.write_text(assembled, encoding="utf-8")
    _check_syntax(BUNDLE)
    print(f"已生成 {BUNDLE}（{len(assembled.encode('utf-8'))} 字节），且通过语法校验。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
