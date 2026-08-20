"""
精修引擎 — OpenAI 兼容接口
===========================
设计原则：
  - Refiner 负责 AI 精修：原始转录 → 精修稿
  - 所有实现兼容 OpenAI Chat Completions API（/v1/chat/completions）
  - 更换提供商只需改配置里的 api_base 和 model
  - 支持任意 OpenAI 兼容提供商
  - 服务商地址与模型只从配置读取，代码不硬编码任何提供商；鉴权 Key 只从 .env 注入
"""
from __future__ import annotations

import logging
import os
import re
import time
from abc import ABC, abstractmethod
from typing import Callable

logger = logging.getLogger(__name__)


def extract_markdown(text: str) -> str:
    """从返回文本中提取 Markdown 代码块，无代码块则直接返回。"""
    patterns = [
        r"```markdown\s*(.*?)\s*```",
        r"```\s*(.*?)\s*```",
    ]
    for pattern in patterns:
        matches = re.findall(pattern, text, re.DOTALL)
        if matches:
            return "\n\n".join(m.strip() for m in matches)
    return text.strip()


def build_chat_request(model: str, api_key: str, messages: list[dict], *, max_tokens: int, temperature: float) -> tuple[dict, dict]:
    """构造 OpenAI 兼容 Chat Completions 的 headers 与 body（含 deepseek 关闭 reasoning）。"""
    body = {
        "model": model,
        "messages": messages,
        "max_tokens": int(max_tokens),
        "temperature": float(temperature),
    }
    model_lower = (model or "").lower()
    if "deepseek" in model_lower and ("v4" in model_lower or "reasoner" in model_lower):
        body["thinking"] = {"type": "disabled"}
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    return headers, body


# ── 抽象基类 ──────────────────────────────────────────────


class BaseRefiner(ABC):
    """精修引擎基类。所有精修引擎返回精修后的文本字符串。"""

    @abstractmethod
    def call(
        self,
        prompt: str,
        text_content: str,
        progress_callback: Callable | None = None,
    ) -> str | None:
        ...


# ── OpenAI 兼容精修 ────────────────────────────────────────


class OpenaiCompatRefiner(BaseRefiner):
    """
    调用任意 OpenAI 兼容的 Chat Completions API 进行精修。

    config 示例 (config.yaml refiner 段)：
      refiner:
        api_base: <你的服务商地址>/v1   # 从配置读取，代码不硬编码
        model: <模型名>
        max_tokens: 65536
        temperature: 0.3
        max_retries: 3
        timeout: 600            # 请求超时秒数（可选，默认 600）
    """

    def __init__(self, config: dict):
        # 服务商地址与模型只从配置读取；缺失时明确报错，绝不回退到任何硬编码提供商。
        self.api_base = str(config.get("api_base", "")).strip().rstrip("/")
        self.model = str(config.get("model", "")).strip()
        if not self.api_base or not self.model:
            raise ValueError(
                "未配置精修服务商：请在 config.yaml 的 refiner 段填写 api_base 和 model"
                "（参考 modules/config.default.yaml 注释与 README「申请 AI Key」）。"
            )

        self.api_key = os.environ.get("REFINER_API_KEY", "")
        if not self.api_key:
            logger.warning("未设置 API Key。请在 .env 中设置 REFINER_API_KEY")

        # ── 请求参数（全部来自 config）──
        self.max_tokens = int(config.get("max_tokens", 65536))
        self.temperature = float(config.get("temperature", 0.3))
        self.max_retries = int(config.get("max_retries", 3))
        self.timeout = int(config.get("timeout", 600))

        self._chat_url = f"{self.api_base}/chat/completions"
        logger.info("精修引擎: OpenAI 兼容 | %s | timeout=%ds", self.model, self.timeout)

    def call(
        self,
        prompt: str,
        text_content: str,
        progress_callback: Callable | None = None,
    ) -> str | None:
        """
        发送精修请求至 OpenAI Chat Completions API。

        参数:
            prompt: 系统/用户提示词
            text_content: 待精修的原始文本
            progress_callback: 进度回调 (stage, pct, msg)

        返回:
            精修后的文本，或 None（全部重试均失败）
        """
        import httpx

        full_content = f"{prompt}\n\n{text_content}"

        # ── 构造 OpenAI 标准请求 ──
        headers, body = build_chat_request(
            self.model,
            self.api_key,
            [
                {"role": "system", "content": "你是一位专业的播客文字整理者。严格按照用户指令处理文本。"},
                {"role": "user", "content": full_content},
            ],
            max_tokens=self.max_tokens,
            temperature=self.temperature,
        )

        # ── 重试循环（指数退避）──
        last_error: str | None = None

        for attempt in range(self.max_retries):
            try:
                if progress_callback:
                    progress_callback("refining", 5, f"发送至 {self.model}... (尝试 {attempt + 1}/{self.max_retries})")

                resp = httpx.post(
                    self._chat_url,
                    headers=headers,
                    json=body,
                    timeout=self.timeout,
                )

                # ── 响应状态处理 ──
                if resp.status_code == 200:
                    data = resp.json()

                    # 解析 OpenAI 标准响应格式
                    output = (
                        data.get("choices", [{}])[0]
                        .get("message", {})
                        .get("content", "")
                        .strip()
                    )

                    # 检查 finish_reason（如被截断则记录）
                    finish_reason = (
                        data.get("choices", [{}])[0]
                        .get("finish_reason", "stop")
                    )
                    if finish_reason == "length":
                        logger.warning("模型输出达到 max_tokens 上限，文本可能被截断")
                        if progress_callback:
                            progress_callback("refining", 98, "警告：输出达到长度上限，可能被截断")

                    if output:
                        if progress_callback:
                            progress_callback("refining", 100, "精修完成")
                        return extract_markdown(output)

                    logger.warning("API 返回空 content (attempt %d/%d)", attempt + 1, self.max_retries)
                    last_error = "API 返回空内容"

                elif resp.status_code == 429:
                    # 速率限制：指数退避
                    wait = 2 ** attempt * 10
                    logger.warning("触发频率限制 (429)，等待 %ds (attempt %d/%d)", wait, attempt + 1, self.max_retries)
                    if progress_callback:
                        progress_callback("refining", -1, f"触发频率限制，等待 {wait}s ({attempt + 1}/{self.max_retries})")
                    time.sleep(wait)
                    last_error = "速率限制 (429)"
                    continue

                elif resp.status_code == 401:
                    logger.error("API 鉴权失败 (401)，请检查 REFINER_API_KEY")
                    if progress_callback:
                        progress_callback("error", 0, "API 鉴权失败，请检查 .env 中的 REFINER_API_KEY")
                    return None  # 鉴权错误不重试

                elif resp.status_code == 400:
                    logger.error("API 请求参数错误 (400)，响应正文未写入日志")
                    if progress_callback:
                        progress_callback("error", 0, "API 请求参数错误 (400)")
                    return None  # 请求错误不重试

                else:
                    logger.error("API 返回异常状态码 %d，响应正文未写入日志", resp.status_code)
                    last_error = f"API 返回 {resp.status_code}"
                    if progress_callback:
                        progress_callback("refining", -1, f"API 返回 {resp.status_code} (尝试 {attempt + 1}/{self.max_retries})")

            except httpx.TimeoutException:
                logger.error("请求超时 (attempt %d/%d, timeout=%ds)", attempt + 1, self.max_retries, self.timeout)
                last_error = f"请求超时 ({self.timeout}s)"
                if progress_callback:
                    progress_callback("refining", -1, f"请求超时 ({self.timeout}s)，尝试 {attempt + 1}/{self.max_retries}")

            except httpx.ConnectError as e:
                logger.error("连接失败 (attempt %d/%d): %s", attempt + 1, self.max_retries, e)
                last_error = f"连接失败: {e}"
                if progress_callback:
                    progress_callback("refining", -1, f"连接失败 (尝试 {attempt + 1}/{self.max_retries})")

            except Exception as e:
                logger.error("精修调用异常 (attempt %d/%d): %s", attempt + 1, self.max_retries, e)
                last_error = str(e)
                if progress_callback:
                    progress_callback("refining", -1, f"精修调用出错，正在重试 ({attempt + 1}/{self.max_retries})")

            # 指数退避（最后一次不等待）
            if attempt < self.max_retries - 1:
                wait_sec = 2 ** attempt
                time.sleep(wait_sec)

        # 全部重试失败
        logger.error("精修失败，已重试 %d 次。最后错误: %s", self.max_retries, last_error)
        return None


# ── 工厂 ──────────────────────────────────────────────────


def get_refiner(config: dict) -> BaseRefiner:
    """
    根据配置返回精修引擎。
    服务商地址、模型和普通参数只来自 config；鉴权 Key 只从 REFINER_API_KEY 注入。

    config 结构 (config.yaml refiner 段)：
      refiner:
        api_base: <你的服务商地址>/v1
        model: <模型名>
        max_tokens: 65536
        temperature: 0.3
        max_retries: 3
        timeout: 600
    """
    return OpenaiCompatRefiner(config)


class AssistantError(RuntimeError):
    """AI 助手（问答/百科查询）调用失败。"""


def assistant_available(config: dict | None) -> bool:
    """助手是否可用：需要配置 api_base、model 与 REFINER_API_KEY。"""
    config = config or {}
    has_provider = bool(str(config.get("api_base", "")).strip()) and bool(
        str(config.get("model", "")).strip()
    )
    return has_provider and bool(os.environ.get("REFINER_API_KEY", ""))


def chat_completion(
    messages: list[dict],
    config: dict,
    *,
    max_tokens: int = 1500,
    temperature: float = 0.4,
) -> str:
    """通用 OpenAI 兼容对话补全，供 AI 助手（转录问答、百科查询）复用。

    复用 refiner 的服务商配置（``api_base`` / ``model``）与 ``REFINER_API_KEY``，
    返回纯文本回答。任何失败都抛出 :class:`AssistantError`，由上层转成 HTTP 错误。
    """
    import httpx

    api_base = str((config or {}).get("api_base", "")).strip().rstrip("/")
    model = str((config or {}).get("model", "")).strip()
    if not api_base or not model:
        raise AssistantError(
            "未配置 AI 服务商：请在 config.yaml 的 refiner 段填写 api_base 和 model。"
        )
    api_key = os.environ.get("REFINER_API_KEY", "")
    if not api_key:
        raise AssistantError("未设置 REFINER_API_KEY，请在 .env 中填写后重试。")

    timeout = int((config or {}).get("timeout", 120))
    max_retries = max(1, int((config or {}).get("max_retries", 3)))
    headers, body = build_chat_request(
        model, api_key, messages, max_tokens=max_tokens, temperature=temperature
    )
    chat_url = f"{api_base}/chat/completions"

    last_error = "未知错误"
    for attempt in range(max_retries):
        try:
            resp = httpx.post(chat_url, headers=headers, json=body, timeout=timeout)
        except httpx.TimeoutException:
            last_error = "请求超时"
            continue
        except httpx.HTTPError as exc:
            last_error = f"网络错误: {exc}"
            continue

        if resp.status_code == 200:
            content = (
                resp.json()
                .get("choices", [{}])[0]
                .get("message", {})
                .get("content", "")
                .strip()
            )
            if content:
                return content
            last_error = "API 返回空内容"
            continue
        if resp.status_code == 401:
            raise AssistantError("AI 鉴权失败，请检查 REFINER_API_KEY。")
        if resp.status_code == 400:
            raise AssistantError("AI 请求参数错误（400）。")
        if resp.status_code == 429 and attempt < max_retries - 1:
            time.sleep(2 ** attempt)
            last_error = "触发频率限制（429）"
            continue
        last_error = f"AI 返回 {resp.status_code}"

    raise AssistantError(f"AI 调用失败：{last_error}")


def build_refine_prompt(summary: str, refiner_config: dict | None = None) -> str:
    """构建 RSS 单集精修 prompt。

    优先使用 ``refiner_config['refine_prompt']``（含 ``{summary}`` 占位符，
    默认模板见 ``modules/config.default.yaml``）；缺失时回退极简模板。
    """
    template = ((refiner_config or {}).get("refine_prompt") or "").strip()
    if not template:
        template = "节目简介: {summary}"
    return template.replace("{summary}", summary or "无官方简介")
