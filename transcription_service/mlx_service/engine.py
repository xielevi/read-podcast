"""MLX Whisper 模型管理器：按需惰性加载与超时自动释放内存/显存。"""
from __future__ import annotations

import asyncio
import gc
import logging
import os
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger("mlx_service")

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"
DEFAULT_IDLE_TIMEOUT = 900  # 15 分钟空闲自动卸载


def _stub_allowed() -> bool:
    """占位/模拟转录只在显式测试开关下允许。

    默认必须失败（而不是返回「测试模拟转录文本」）：假转录会污染 raw → 让整条
    Edge 精修链路产出假稿件。缺少 mlx_whisper 时宁可 5xx 报错并让人修复环境。
    """
    return os.environ.get("READ_PODCAST_MLX_ALLOW_STUB", "").strip().lower() in {"1", "true", "yes"}


MLX_MISSING_HINT = (
    "未安装 mlx_whisper：无法在本机执行真实转录。请安装依赖（Apple Silicon："
    "`uv add \"mlx-whisper>=0.4.3; sys_platform == 'darwin'\"`）后重启 MLX 服务；"
    "仅测试时可设置 READ_PODCAST_MLX_ALLOW_STUB=1 启用占位返回。"
)


class MLXEngine:
    def __init__(self) -> None:
        # 内建默认（不是 deployment configuration）：模型与空闲卸载时间都由程序固定。
        self.model_name = DEFAULT_MODEL
        self.idle_timeout = DEFAULT_IDLE_TIMEOUT
        self._model: Any = None
        self._last_active: float = time.time()
        self._lock = asyncio.Lock()
        self._progress: dict[str, dict[str, int]] = {}

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def idle_seconds(self) -> float:
        return max(0.0, time.time() - self._last_active)

    def touch(self) -> None:
        self._last_active = time.time()

    async def ensure_model(self) -> Any:
        async with self._lock:
            self.touch()
            if self._model is None:
                logger.info("正在按需加载 MLX Whisper 模型：%s", self.model_name)
                if _stub_allowed():
                    logger.warning("占位模式（READ_PODCAST_MLX_ALLOW_STUB=1），不加载真实模型")
                    self._model = "mock_model"
                else:
                    try:
                        import mlx_whisper  # noqa: F401
                    except ImportError:
                        logger.error(MLX_MISSING_HINT)
                        raise RuntimeError(MLX_MISSING_HINT) from None
                    # mlx_whisper 内部有模型缓存机制，但我们需要保持加载句柄以供复用
                    self._model = self.model_name
                    logger.info("MLX Whisper 模型加载完成：%s", self.model_name)
            return self._model

    async def unload_model(self) -> bool:
        async with self._lock:
            if self._model is None:
                return False
            logger.info("空闲超时（%.1f 秒），正在卸载 MLX Whisper 模型以释放显存", self.idle_seconds)
            self._model = None
            gc.collect()
            try:
                import mlx.core as mx
                mx.metal.clear_cache()
            except (ImportError, AttributeError):
                pass
            logger.info("MLX 显存与内存已成功释放")
            return True

    def set_progress(self, request_id: str, progress: int, completed: int, total: int) -> None:
        self._progress[request_id] = {
            "progress": progress,
            "completed_chunks": completed,
            "total_chunks": total,
        }

    def get_progress(self, request_id: str) -> dict[str, int]:
        return self._progress.get(request_id, {"progress": 0, "completed_chunks": 0, "total_chunks": 0})

    def delete_progress(self, request_id: str) -> None:
        self._progress.pop(request_id, None)

    async def transcribe(self, audio_file: str | Path, request_id: str | None = None, language: str | None = None) -> dict[str, Any]:
        audio_path = Path(audio_file).resolve()
        if not audio_path.is_file():
            raise FileNotFoundError(f"音频文件不存在: {audio_path}")

        await self.ensure_model()
        self.touch()

        if request_id:
            self.set_progress(request_id, 10, 0, 1)

        try:
            # 在独立线程执行繁重推理，不阻塞主事件循环
            return await asyncio.to_thread(self._transcribe_sync, str(audio_path), request_id, language)
        finally:
            self.touch()
            if request_id:
                self.set_progress(request_id, 100, 1, 1)

    def _transcribe_sync(self, audio_path: str, request_id: str | None, language: str | None = None) -> dict[str, Any]:
        if _stub_allowed():
            # 占位/模拟返回（仅 READ_PODCAST_MLX_ALLOW_STUB=1，用于无 mlx 环境的测试）
            logger.info("占位转录执行: %s", audio_path)
            return {
                "text": f"测试模拟转录文本: {Path(audio_path).name}",
                "language": "zh",
                "segments": [{"start": 0.0, "end": 1.0, "text": "测试"}],
                "duration": 1.0,
            }

        try:
            import mlx_whisper
        except ImportError:
            logger.error(MLX_MISSING_HINT)
            raise RuntimeError(MLX_MISSING_HINT) from None

        logger.info("开始 MLX Whisper 转录: %s (model=%s)", audio_path, self.model_name)
        kwargs: dict[str, Any] = {"path_or_hf_repo": self.model_name, "verbose": False}
        if language:
            kwargs["language"] = language
        result = mlx_whisper.transcribe(audio_path, **kwargs)
        segments = result.get("segments", []) or []
        # mlx_whisper 不直接给总时长：取末段结束时间。
        duration = result.get("duration") or (segments[-1].get("end", 0.0) if segments else 0.0)
        return {
            "text": result.get("text", "").strip(),
            "language": result.get("language", language or "zh"),
            "segments": segments,
            "duration": duration,
        }

    async def idle_watchdog_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(30)
                if self.is_loaded and self.idle_seconds >= self.idle_timeout:
                    await self.unload_model()
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                logger.error("Idle watchdog 异常: %s", exc)


engine = MLXEngine()
