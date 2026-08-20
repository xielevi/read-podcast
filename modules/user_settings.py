"""WebUI「个人配置」面板的读写逻辑。

配置分层保持不变（见 ``docs/ARCHITECTURE.md`` D4/D12）：``modules/config.default.yaml``
提供内置默认值，持久化 ``config/config.yaml`` 保存用户覆盖，机密写入同目录的
``secrets.env``（权限 0600，不进镜像、不进版本库）。

两条硬约束：

* **只有部署方从外部注入的环境变量**（Compose / shell）才接管字段并标记只读。
  写在 ``.env`` 里的值不算——它和 ``secrets.env`` 一样只是本机文件，若也锁死面板，
  用户就会发现自己最想改的 Key 恰恰在网页上改不了。手动编辑与面板保存统一落在
  ``config/secrets.env``。
* 接口任何时候都不回传机密内容，只回传「是否已配置」；连通性由 ``/settings/test``
  在服务端验证。
"""
from __future__ import annotations

import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple
from urllib.parse import urlparse, urlunparse

import httpx
import yaml

from modules.config import is_external_env, settings
from modules.refiner import AssistantError, chat_completion

logger = logging.getLogger("UserSettings")

SECRET_PREFIX = "secret."
PROBE_TIMEOUT_SECONDS = 20
MAX_VALUE_LENGTH = 2048
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_URL_PATTERN = re.compile(r"https?://\S+")

SECRETS_HEADER = (
    "# Read Podcast 机密文件（权限 0600）。这里是密钥的唯一落点：\n"
    "# 网页「设置」面板写入这个文件，你也可以直接手动编辑它，两者作用于同一份配置。\n"
    "# 只有部署方从外部注入的环境变量（Docker Compose / shell）会覆盖这里的同名项。\n"
)


class SettingsError(ValueError):
    """配置校验或写入失败。"""


class SettingsProbeError(RuntimeError):
    """连通性预检失败。"""


# ── 字段定义 ────────────────────────────────────────────────

GROUPS: Tuple[Dict[str, str], ...] = (
    {
        "key": "refiner",
        "title": "AI 精修与助手",
        "description": "任何 OpenAI 兼容服务商都可以用。地址和模型名要成对填写，Key 单独保存在服务器上。",
    },
    {
        "key": "transcription",
        "title": "语音转录",
        "description": "mlx-api 走本机 MLX 服务（仅 Apple 芯片）；openai-api 走任意 OpenAI 兼容转录接口，跨平台可用。",
    },
    {
        "key": "paths",
        "title": "文件存放位置",
        "description": "相对路径以项目目录为基准；留空则恢复默认值。",
    },
)

FIELDS: Tuple[Dict[str, Any], ...] = (
    # ── AI 精修与助手 ──
    {
        "key": "refiner.api_base",
        "group": "refiner",
        "label": "服务地址（api_base）",
        "type": "url",
        "placeholder": "https://api.deepseek.com/v1",
        "hint": "OpenAI 兼容地址，通常以 /v1 结尾。",
    },
    {
        "key": "refiner.model",
        "group": "refiner",
        "label": "模型名称",
        "type": "text",
        "placeholder": "deepseek-chat",
        "hint": "以服务商文档里的模型名为准。",
    },
    {
        "key": SECRET_PREFIX + "REFINER_API_KEY",
        "group": "refiner",
        "label": "API Key",
        "type": "secret",
        "env": "REFINER_API_KEY",
        "hint": "只写入服务器上的 config/secrets.env，接口不会回传。留空并保存即可清除。",
    },
    {
        "key": "refiner.temperature",
        "group": "refiner",
        "label": "温度",
        "type": "float",
        "min": 0.0,
        "max": 2.0,
        "placeholder": "0.3",
        "hint": "越低越稳定，精修建议 0.2 ~ 0.5。",
    },
    {
        "key": "refiner.max_tokens",
        "group": "refiner",
        "label": "单次最大输出 tokens",
        "type": "int",
        "min": 256,
        "max": 1_048_576,
        "placeholder": "65536",
    },
    {
        "key": "refiner.timeout",
        "group": "refiner",
        "label": "请求超时（秒）",
        "type": "int",
        "min": 30,
        "max": 7200,
        "placeholder": "600",
    },
    # ── 语音转录 ──
    {
        "key": "transcription.backend",
        "group": "transcription",
        "label": "转录后端",
        "type": "select",
        "options": (
            {"value": "mlx-api", "label": "mlx-api（本机 MLX，仅 Apple 芯片）"},
            {"value": "openai-api", "label": "openai-api（OpenAI 兼容接口，跨平台）"},
        ),
        "env_names": ("READ_PODCAST_TRANSCRIPTION_BACKEND",),
    },
    {
        "key": "transcription.api_url",
        "group": "transcription",
        "label": "MLX 服务地址",
        "type": "url",
        "placeholder": "http://127.0.0.1:21567/transcribe",
        "hint": "mlx-api 后端使用；一键启动脚本会自动写入本机默认地址。",
        "env_names": (
            "READ_PODCAST_TRANSCRIPTION_API_URL",
            "PODCAST2MD_TRANSCRIPTION_API_URL",
        ),
    },
    {
        "key": SECRET_PREFIX + "READ_PODCAST_WHISPER_API_TOKEN",
        "group": "transcription",
        "label": "MLX 访问口令",
        "type": "secret",
        "env": "READ_PODCAST_WHISPER_API_TOKEN",
        "hint": "mlx-api 后端可选；跨设备访问时必须设置一串长随机字符串。",
    },
    {
        "key": "transcription.openai.api_base",
        "group": "transcription",
        "label": "转录服务地址（api_base）",
        "type": "url",
        "placeholder": "https://api.groq.com/openai/v1",
        "hint": "openai-api 后端使用，指向提供 /audio/transcriptions 的兼容服务。",
        "env_names": ("READ_PODCAST_TRANSCRIPTION_OPENAI_API_BASE",),
    },
    {
        "key": "transcription.openai.model",
        "group": "transcription",
        "label": "转录模型",
        "type": "text",
        "placeholder": "whisper-large-v3",
        "env_names": ("READ_PODCAST_TRANSCRIPTION_OPENAI_MODEL",),
    },
    {
        "key": SECRET_PREFIX + "READ_PODCAST_TRANSCRIPTION_API_KEY",
        "group": "transcription",
        "label": "转录 API Key",
        "type": "secret",
        "env": "READ_PODCAST_TRANSCRIPTION_API_KEY",
        "hint": "openai-api 后端使用；本机 MLX 或内置转录容器可留空。",
    },
    {
        "key": "transcription.openai.language",
        "group": "transcription",
        "label": "转录语言",
        "type": "text",
        "placeholder": "zh",
        "hint": "留空自动检测；填 zh、en 等可提升准确率。",
        "env_names": ("READ_PODCAST_TRANSCRIPTION_OPENAI_LANGUAGE",),
    },
    {
        "key": "transcription.openai.timeout",
        "group": "transcription",
        "label": "转录请求超时（秒）",
        "type": "int",
        "min": 30,
        "max": 7200,
        "placeholder": "1800",
        "env_names": ("READ_PODCAST_TRANSCRIPTION_OPENAI_TIMEOUT",),
    },
    {
        "key": "transcription.openai.max_upload_bytes",
        "group": "transcription",
        "label": "单文件上传上限（字节）",
        "type": "int",
        "min": 0,
        "max": 17_179_869_184,
        "placeholder": "0",
        "hint": "0 表示不限制；云端接口一般限制 26214400（25MB）。",
        "env_names": ("READ_PODCAST_TRANSCRIPTION_OPENAI_MAX_UPLOAD_BYTES",),
    },
    # ── 文件存放位置 ──
    {
        "key": "paths.obsidian_markdown_dir",
        "group": "paths",
        "label": "成稿输出目录",
        "type": "path",
        "placeholder": "留空则保存到 workspace/<节目名>/markdown",
        "hint": "可以直接填 Obsidian 仓库里的目录，成稿会写到那里。",
        "env_names": ("READ_PODCAST_OUTPUT_DIR", "PODCAST2MD_OUTPUT_DIR"),
    },
    {
        "key": "paths.download_dir",
        "group": "paths",
        "label": "音频下载目录",
        "type": "path",
        "placeholder": "workspace/downloads",
    },
)

_FIELDS_BY_KEY: Dict[str, Dict[str, Any]] = {field["key"]: field for field in FIELDS}


# ── 读取 ────────────────────────────────────────────────────


def _env_override(env_names: Iterable[str]) -> Tuple[str, str]:
    """返回接管该字段的环境变量名与值；未被接管时返回空串。

    与机密同理，只有**外部注入**（Compose / shell）才算接管；写在 ``.env``
    里的值不锁定面板，否则用户改不了自己在本机填过的字段。
    """
    for name in env_names or ():
        value = os.environ.get(name, "")
        if value and is_external_env(name):
            return name, value
    return "", ""


def _secret_is_external(env_name: str) -> bool:
    """机密是否由部署方从外部注入（Compose / shell），因而面板不该改写。

    只认真正的外部注入。写在 ``.env`` 里的值**不算**——它和 ``secrets.env``
    一样只是本机文件，锁死面板会让用户在网页上根本改不了自己的 Key。
    """
    if not os.environ.get(env_name, ""):
        return False
    return is_external_env(env_name)


def _describe_field(field: Dict[str, Any]) -> Dict[str, Any]:
    described: Dict[str, Any] = {
        "key": field["key"],
        "label": field["label"],
        "type": field["type"],
        "hint": field.get("hint", ""),
        "placeholder": field.get("placeholder", ""),
        "locked": False,
        "locked_reason": "",
    }
    if field["type"] == "select":
        described["options"] = [dict(option) for option in field.get("options", ())]

    if field["type"] == "secret":
        env_name = field["env"]
        described["configured"] = bool(os.environ.get(env_name, ""))
        if _secret_is_external(env_name):
            described["locked"] = True
            described["locked_reason"] = f"由部署环境注入的 {env_name} 接管，请在 Compose 或启动脚本中修改。"
        return described

    env_name, env_value = _env_override(field.get("env_names", ()))
    if env_name:
        described["value"] = env_value
        described["locked"] = True
        described["locked_reason"] = f"由部署环境注入的 {env_name} 接管，请在 Compose 或启动脚本中修改。"
        return described

    value = settings.get_value(field["key"])
    described["value"] = "" if value is None else str(value)
    return described


def _writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    return os.access(path, os.W_OK)


def describe_settings() -> Dict[str, Any]:
    """面板需要的全部字段与状态；不含任何机密内容。"""
    writable = _writable(settings.CONFIG_PATH.parent)
    groups = []
    for group in GROUPS:
        groups.append(
            {
                **group,
                "fields": [
                    _describe_field(field) for field in FIELDS if field["group"] == group["key"]
                ],
            }
        )
    return {"groups": groups, "writable": writable}


# ── 校验 ────────────────────────────────────────────────────


def _clean(raw: Any) -> str:
    text = "" if raw is None else str(raw)
    if _CONTROL_CHARS.search(text) or "\n" in text or "\r" in text:
        raise SettingsError("包含不允许的控制字符")
    if len(text) > MAX_VALUE_LENGTH:
        raise SettingsError(f"长度超过 {MAX_VALUE_LENGTH} 字符")
    return text.strip()


def _validate_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SettingsError("必须是以 http:// 或 https:// 开头的完整地址")
    # 统一去掉结尾斜杠：下游拼接 /chat/completions、/models 时不会出现双斜杠。
    return value.rstrip("/")


def _validate_number(value: str, field: Dict[str, Any]) -> Any:
    try:
        number = int(value) if field["type"] == "int" else float(value)
    except ValueError as exc:
        raise SettingsError("必须是数字") from exc
    minimum = field.get("min")
    maximum = field.get("max")
    if minimum is not None and number < minimum:
        raise SettingsError(f"不能小于 {minimum}")
    if maximum is not None and number > maximum:
        raise SettingsError(f"不能大于 {maximum}")
    return number


def _abs_path(value: str) -> Path:
    candidate = Path(value).expanduser()
    if candidate.is_absolute():
        return candidate
    return (settings.PROJECT_ROOT / candidate).absolute()


def _validate_directory(value: str) -> str:
    target = _abs_path(value)
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise SettingsError(f"目录无法创建（{exc.strerror or '权限不足'}）") from exc
    if not os.access(target, os.W_OK):
        raise SettingsError("目录不可写")
    return value


def _normalize(field: Dict[str, Any], raw: Any) -> Any:
    value = _clean(raw)
    if not value:
        return None  # 空值表示删除覆盖项，回落到内置默认值
    field_type = field["type"]
    if field_type == "url":
        return _validate_url(value)
    if field_type in {"int", "float"}:
        return _validate_number(value, field)
    if field_type == "select":
        allowed = {option["value"] for option in field.get("options", ())}
        if value not in allowed:
            raise SettingsError("不是可选项之一")
        return value
    if field_type == "path":
        return _validate_directory(value)
    return value


# ── 写入 ────────────────────────────────────────────────────


def _atomic_write(path: Path, content: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent), prefix=f".{path.name}.", delete=False
    )
    try:
        with handle as stream:
            stream.write(content)
        os.chmod(handle.name, mode)
        os.replace(handle.name, path)
    except BaseException:
        Path(handle.name).unlink(missing_ok=True)
        raise


def _write_config_values(updates: Dict[str, Any], deletions: List[str]) -> None:
    """把普通配置写入持久化 config.yaml，兼容顶层与命名空间两种结构。"""
    if not updates and not deletions:
        return
    path = settings.CONFIG_PATH
    raw: Dict[str, Any] = {}
    if path.exists():
        try:
            loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            raise SettingsError("持久化配置文件不是合法 YAML，请先修复后重试") from exc
        if isinstance(loaded, dict):
            raw = loaded
    service = raw.get("read-podcast", raw.get("podcast2md", raw))
    if not isinstance(service, dict):
        raise SettingsError("持久化配置文件结构异常，请先修复后重试")

    for key, value in updates.items():
        node = service
        parts = key.split(".")
        for part in parts[:-1]:
            child = node.get(part)
            if not isinstance(child, dict):
                child = {}
                node[part] = child
            node = child
        node[parts[-1]] = value

    for key in deletions:
        node = service
        parts = key.split(".")
        for part in parts[:-1]:
            child = node.get(part)
            if not isinstance(child, dict):
                node = None
                break
            node = child
        if isinstance(node, dict):
            node.pop(parts[-1], None)

    try:
        dumped = yaml.dump(raw, allow_unicode=True, default_flow_style=False, sort_keys=False)
        _atomic_write(path, dumped)
    except OSError as exc:
        logger.exception("写入持久化配置失败")
        raise SettingsError("写入配置文件失败，请检查 config 目录是否可写") from exc


def _parse_secrets_file(path: Path) -> Dict[str, str]:
    if not path.exists():
        return {}
    parsed: Dict[str, str] = {}
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    for line in content.splitlines():
        entry = line.strip()
        if not entry or entry.startswith("#"):
            continue
        if entry.startswith("export "):
            entry = entry[len("export "):].lstrip()
        key, separator, value = entry.partition("=")
        key = key.strip()
        if not separator or not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        parsed[key] = value
    return parsed


def _write_secrets(updates: Dict[str, str]) -> None:
    """机密写入 config/secrets.env（0600），并同步到当前进程环境变量。"""
    if not updates:
        return
    path = settings.SECRETS_PATH
    stored = _parse_secrets_file(path)
    for key, value in updates.items():
        if value:
            stored[key] = value
        else:
            stored.pop(key, None)

    body = SECRETS_HEADER + "".join(f"{key}={value}\n" for key, value in stored.items())
    try:
        _atomic_write(path, body, mode=0o600)
    except OSError as exc:
        logger.exception("写入机密文件失败")
        raise SettingsError("写入机密文件失败，请检查 config 目录是否可写") from exc

    managed = getattr(settings, "MANAGED_SECRET_KEYS", set())
    for key, value in updates.items():
        if value:
            os.environ[key] = value
            managed.add(key)
        else:
            if key in managed:
                os.environ.pop(key, None)
                managed.discard(key)


def apply_settings(values: Dict[str, Any] | None, secrets: Dict[str, Any] | None) -> Dict[str, Any]:
    """校验并落盘用户配置，随后热重载进程内配置。"""
    updates: Dict[str, Any] = {}
    deletions: List[str] = []
    secret_updates: Dict[str, str] = {}
    errors: List[str] = []

    for key, raw in (values or {}).items():
        field = _FIELDS_BY_KEY.get(str(key))
        if not field or field["type"] == "secret":
            errors.append(f"未知配置项：{key}")
            continue
        env_name, _value = _env_override(field.get("env_names", ()))
        if env_name:
            errors.append(f"{field['label']}：由环境变量 {env_name} 接管，无法在页面修改")
            continue
        try:
            normalized = _normalize(field, raw)
        except SettingsError as exc:
            errors.append(f"{field['label']}：{exc}")
            continue
        if normalized is None:
            deletions.append(field["key"])
        else:
            updates[field["key"]] = normalized

    for env_name, raw in (secrets or {}).items():
        field = _FIELDS_BY_KEY.get(SECRET_PREFIX + str(env_name))
        if not field:
            errors.append(f"未知机密项：{env_name}")
            continue
        if _secret_is_external(field["env"]):
            errors.append(f"{field['label']}：由环境变量 {field['env']} 接管，无法在页面修改")
            continue
        try:
            secret_updates[field["env"]] = _clean(raw)
        except SettingsError as exc:
            errors.append(f"{field['label']}：{exc}")

    if errors:
        raise SettingsError("；".join(errors))

    _write_config_values(updates, deletions)
    _write_secrets(secret_updates)
    settings.reload()
    return describe_settings()


# ── 连通性预检 ──────────────────────────────────────────────


def _redact(message: str) -> str:
    """预检失败信息里不回传服务地址，避免接口意外泄露部署细节。"""
    return _URL_PATTERN.sub("[服务地址]", str(message))


def probe_refiner() -> Dict[str, Any]:
    """用一次极小的对话请求验证 AI 服务商配置是否可用。"""
    config = dict(settings.REFINER_CONFIG or {})
    model = str(config.get("model", "")).strip()
    if not str(config.get("api_base", "")).strip() or not model:
        raise SettingsProbeError("请先填写 AI 服务地址和模型名称。")
    if not os.environ.get("REFINER_API_KEY", ""):
        raise SettingsProbeError("请先填写 AI API Key。")

    config["timeout"] = PROBE_TIMEOUT_SECONDS
    config["max_retries"] = 1
    try:
        chat_completion(
            [{"role": "user", "content": "ping"}], config, max_tokens=16, temperature=0
        )
    except AssistantError as exc:
        raise SettingsProbeError(_redact(exc)) from exc
    return {"ok": True, "detail": f"AI 服务已连通（模型 {model}）"}


def _probe_openai_transcription(config: Dict[str, Any]) -> Dict[str, Any]:
    openai_config = dict(config.get("openai") or {})
    api_base = str(openai_config.get("api_base", "")).strip().rstrip("/")
    if not api_base:
        raise SettingsProbeError("请先填写转录服务地址（OpenAI 兼容 api_base）。")
    if not str(openai_config.get("model", "")).strip():
        raise SettingsProbeError("请先填写转录模型名称。")
    api_key = os.environ.get("READ_PODCAST_TRANSCRIPTION_API_KEY", "") or os.environ.get(
        "PODCAST2MD_TRANSCRIPTION_API_KEY", ""
    )
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        response = httpx.get(
            f"{api_base}/models", headers=headers, timeout=PROBE_TIMEOUT_SECONDS
        )
    except httpx.HTTPError as exc:
        logger.info("转录服务预检失败: %s", _redact(exc))
        raise SettingsProbeError("无法连接到转录服务，请检查地址与网络。") from exc
    if response.status_code in {401, 403}:
        raise SettingsProbeError("转录服务鉴权失败，请检查 API Key。")
    if response.status_code == 404:
        return {"ok": True, "detail": "服务可达，但未提供模型列表接口（不影响转录）。"}
    if response.status_code >= 400:
        raise SettingsProbeError(f"转录服务返回 {response.status_code}。")
    return {"ok": True, "detail": "转录服务已连通。"}


def _probe_mlx_transcription(config: Dict[str, Any]) -> Dict[str, Any]:
    api_url = str(config.get("api_url", "")).strip()
    if not api_url:
        raise SettingsProbeError("请先填写 MLX 服务地址。")
    parsed = urlparse(api_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SettingsProbeError("MLX 服务地址不是合法的 http(s) 地址。")
    health_url = urlunparse((parsed.scheme, parsed.netloc, "/health", "", "", ""))
    token = os.environ.get("READ_PODCAST_WHISPER_API_TOKEN", "") or os.environ.get(
        "PODCAST2MD_WHISPER_API_TOKEN", ""
    )
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        response = httpx.get(health_url, headers=headers, timeout=PROBE_TIMEOUT_SECONDS)
    except httpx.HTTPError as exc:
        logger.info("MLX 预检失败: %s", _redact(exc))
        raise SettingsProbeError("无法连接到本机转录服务，请确认它已启动。") from exc
    if response.status_code in {401, 403}:
        raise SettingsProbeError("本机转录服务鉴权失败，请检查访问口令。")
    if response.status_code >= 400:
        raise SettingsProbeError(f"本机转录服务返回 {response.status_code}。")
    return {"ok": True, "detail": "本机转录服务已连通。"}


def probe_transcription() -> Dict[str, Any]:
    """按当前后端验证转录服务是否可达，不产生真实转录。"""
    config = dict(settings.TRANSCRIPTION_CONFIG or {})
    backend = str(config.get("backend", "mlx-api")).strip() or "mlx-api"
    if backend == "openai-api":
        return _probe_openai_transcription(config)
    return _probe_mlx_transcription(config)
