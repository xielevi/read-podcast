"""Faster-Whisper 引擎：进程内 CPU / CUDA 转录（Linux / Windows / NAS 与容器部署的默认引擎）。

零配置：模型名、设备、计算精度、线程数都是内建默认值，只允许用环境变量逐项覆盖
（见 ``core.config.faster_whisper_options``）。模型文件由 faster-whisper 经 Hugging Face
缓存机制按需下载（容器内通过 ``HF_HOME`` 落到挂载卷），本服务不持有任何凭据。

与 MLX 引擎（本机独立 HTTP 进程）不同，本引擎与 Transcription Service 同进程运行，
直接实现 ``core.transcriber.Transcriber`` 协议；失败仍以带稳定 ``code`` 的 ``EngineError``
抛出，由上层如实上报给 Cloudflare。模型惰性加载后常驻进程（容器即专用转录节点）。
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Any, Callable

from core.config import FasterWhisperOptions, faster_whisper_options
from core.transcriber import EngineError, TranscriptionResult

logger = logging.getLogger(__name__)

FASTER_WHISPER_MISSING_HINT = (
    "未安装 faster-whisper：无法在本机执行真实转录。Linux / Windows 平台默认随依赖安装"
    "（`uv add 'faster-whisper>=1.1.0'`）后重启服务；缺失时宁可报错，也不产出假转录污染 raw。"
)


def _default_model_loader(options: FasterWhisperOptions) -> Any:
    """加载 ``WhisperModel``。依赖缺失 / 模型下载失败都是环境问题 → ``engine_unavailable``。"""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise EngineError("engine_unavailable", FASTER_WHISPER_MISSING_HINT) from None
    try:
        return WhisperModel(
            options.model,
            device=options.device,
            compute_type=options.compute_type,
            cpu_threads=options.cpu_threads,
        )
    except Exception as exc:  # noqa: BLE001 —— 网络 / 磁盘 / 显存问题，稍后可能恢复
        raise EngineError("engine_unavailable", f"加载 Whisper 模型失败: {exc}") from exc


class FasterWhisperTranscriber:
    """进程内 Faster-Whisper 引擎（CPU / CUDA），模型惰性加载并复用。"""

    def __init__(self, *, model_loader: Callable[[FasterWhisperOptions], Any] | None = None):
        self.options = faster_whisper_options()
        self._model_loader = model_loader or _default_model_loader
        self._model: Any = None
        self._lock = threading.Lock()

    def _ensure_model(self) -> Any:
        with self._lock:
            if self._model is None:
                logger.info(
                    "正在加载 Faster-Whisper 模型：%s (device=%s, compute=%s, cpu_threads=%s)",
                    self.options.model,
                    self.options.device,
                    self.options.compute_type,
                    self.options.cpu_threads,
                )
                self._model = self._model_loader(self.options)
            return self._model

    def transcribe(
        self,
        audio_file: str,
        progress_callback: Callable | None = None,
        language: str | None = None,
    ) -> TranscriptionResult:
        if not os.path.isfile(audio_file):
            raise EngineError("engine_failed", f"音频文件不存在: {os.path.basename(audio_file)}")
        # 加载阶段失败（依赖缺失 / 网络 / 磁盘 / 显存）属于环境问题，稍后可能恢复。
        try:
            model = self._ensure_model()
        except EngineError:
            raise
        except ImportError as exc:
            raise EngineError("engine_unavailable", FASTER_WHISPER_MISSING_HINT) from exc
        except Exception as exc:  # noqa: BLE001
            logger.warning("模型加载失败: %s", type(exc).__name__)
            raise EngineError("engine_unavailable", f"加载 Whisper 模型失败: {type(exc).__name__}: {exc}") from exc
        try:
            if progress_callback:
                progress_callback("transcribing", 10, f"转录中 ({self.options.model})…")
            segments_iter, info = model.transcribe(audio_file, language=language)
            duration = float(info.duration or 0.0)
            texts: list[str] = []
            for segment in segments_iter:
                texts.append(segment.text)
                if progress_callback and duration > 0:
                    # 分段推进：映射到 10–95 区间，100 留给「转录完成」。
                    pct = 10 + round(min(segment.end / duration, 1.0) * 85)
                    progress_callback("transcribing", pct, f"分段 {segment.end:.0f}s / {duration:.0f}s")
        except EngineError:
            raise
        except ImportError as exc:
            raise EngineError("engine_unavailable", FASTER_WHISPER_MISSING_HINT) from exc
        except Exception as exc:  # noqa: BLE001 —— 任何转录期异常都落成稳定 code，不让请求悬挂
            logger.warning("转录失败: %s", type(exc).__name__)
            raise EngineError("engine_failed", f"转录失败: {type(exc).__name__}: {exc}") from exc
        text = "".join(texts).strip()
        if not text:
            raise EngineError("transcription_empty", "转录结果为空")
        if progress_callback:
            progress_callback("transcribing", 100, f"转录完成 ({len(text)} 字符)")
        return TranscriptionResult(
            text=text,
            language=getattr(info, "language", None) or language,
            duration=duration or None,
        )
