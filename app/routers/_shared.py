"""跨子路由复用的共享状态与工具。

这里只放**不被测试 monkeypatch** 的共享件：一份配置写入串行锁、成稿文本读取，
以及文本输出的允许扩展名。被测试打桩的名字（``get_task``/``chat_completion`` 等）
一律在各子路由自己的命名空间里 import 并 bare 调用，以保持既有 patch 语义。
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import HTTPException

from app.models.task import Task

logger = logging.getLogger("app.routers")

# 配置写入（订阅列表、设置面板）共用一把锁，串行化对 config.yaml 的读改写。
config_lock = asyncio.Lock()

ALLOWED_TEXT_OUTPUT_EXTS = {".md", ".markdown", ".txt"}


def read_task_output_text(task: Task) -> tuple[Path, str]:
    """读取任务输出文本文件；沿用与 content 接口一致的路径与类型校验。"""
    if not task.output_path:
        raise HTTPException(status_code=404, detail="输出文件尚未生成或已被删除")
    output_file = Path(task.output_path)
    if not output_file.exists():
        raise HTTPException(status_code=404, detail="输出文件尚未生成或已被删除")
    if output_file.suffix.lower() not in ALLOWED_TEXT_OUTPUT_EXTS:
        raise HTTPException(status_code=415, detail="不支持读取非文本输出文件")
    try:
        return output_file, output_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise HTTPException(status_code=500, detail="读取输出文件失败") from exc
