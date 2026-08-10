import os
import yaml
import logging
from pathlib import Path
from dotenv import load_dotenv

_THIS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = _THIS_DIR.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config.default.yaml"

load_dotenv(dotenv_path=PROJECT_ROOT / ".env", override=False)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("Config")


class Settings:
    """
    配置管理类。

    规范命名空间为 ``read-podcast:``，同时兼容旧 ``podcast2md:`` 与顶层配置。
    用户配置递归覆盖内置默认配置；Prompt 模板按名称合并；环境变量只提供路径和凭据。
    """
    def __init__(self, config_path=None):
        self.PROJECT_ROOT = PROJECT_ROOT

        # 配置文件路径（默认持久化目录 config/config.yaml，可由环境变量覆盖）
        env_config = os.getenv("READ_PODCAST_CONFIG", os.getenv("PODCAST2MD_CONFIG"))
        if config_path:
            self.CONFIG_PATH = Path(config_path)
        elif env_config:
            self.CONFIG_PATH = Path(env_config)
        else:
            self.CONFIG_PATH = PROJECT_ROOT / "config" / "config.yaml"

        self._raw_config = self._load_yaml()
        self._initialize_settings()

    @staticmethod
    def _read_yaml(path: Path) -> dict:
        try:
            with path.open('r', encoding='utf-8') as f:
                full = yaml.safe_load(f) or {}
            return full.get('read-podcast', full.get('podcast2md', full))
        except Exception as e:
            logger.error("解析配置文件失败 %s: %s", path, e)
            return {}

    @classmethod
    def _merge_config(cls, base: dict, overrides: dict) -> dict:
        merged = dict(base)
        for key, value in overrides.items():
            if key == "prompt_templates" and isinstance(value, list) and isinstance(merged.get(key), list):
                default_names = {
                    item.get("name")
                    for item in merged[key]
                    if isinstance(item, dict) and item.get("name")
                }
                override_by_name = {
                    item["name"]: item
                    for item in value
                    if isinstance(item, dict) and item.get("name")
                }
                merged[key] = [
                    override_by_name.get(item.get("name"), item)
                    for item in merged[key]
                    if isinstance(item, dict) and item.get("name")
                ]
                merged[key].extend(
                    item for item in value
                    if isinstance(item, dict)
                    and item.get("name")
                    and item["name"] not in default_names
                )
            elif isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key] = cls._merge_config(merged[key], value)
            else:
                merged[key] = value
        return merged

    def _load_yaml(self):
        defaults = self._read_yaml(DEFAULT_CONFIG_PATH) if DEFAULT_CONFIG_PATH.exists() else {}
        if not self.CONFIG_PATH.exists():
            if self.CONFIG_PATH != DEFAULT_CONFIG_PATH:
                logger.info("配置文件未找到: %s，使用内置默认配置。", self.CONFIG_PATH)
            return defaults
        overrides = self._read_yaml(self.CONFIG_PATH)
        if self.CONFIG_PATH.resolve() == DEFAULT_CONFIG_PATH.resolve():
            return overrides
        return self._merge_config(defaults, overrides)

    def _initialize_settings(self):
        # --- [1. 路径系统] ---
        paths = self._raw_config.get('paths', {})

        self.DOWNLOAD_DIR = self._to_abs_path(
            paths.get('download_dir', 'workspace/downloads')
        )
        self.STATE_FILE = self._to_abs_path(
            paths.get('state_file', 'workspace/data/podcast_state.json')
        )
        self.LOG_DIR = self._to_abs_path(
            paths.get('log_dir', 'workspace/log')
        )

        self.OBSIDIAN_MARKDOWN_DIR = None
        # Docker Compose points this at the mounted output directory; local runs
        # intentionally fall back to the per-podcast workspace directory.
        obsidian_dir = (
            os.getenv("READ_PODCAST_OUTPUT_DIR")
            or os.getenv("PODCAST2MD_OUTPUT_DIR")
            or paths.get('obsidian_markdown_dir')
        )
        if obsidian_dir:
            abs_obsidian = self._to_abs_path(obsidian_dir)
            self.OBSIDIAN_MARKDOWN_DIR = abs_obsidian
            logger.info(f"成功加载 Obsidian 路径: {abs_obsidian}")

        # --- [2. 转录与精修] ---
        transcription = dict(self._raw_config.get('transcription', {}))
        backend = os.getenv("READ_PODCAST_TRANSCRIPTION_BACKEND")
        if backend:
            transcription["backend"] = backend
        api_url = os.getenv(
            "READ_PODCAST_TRANSCRIPTION_API_URL",
            os.getenv("PODCAST2MD_TRANSCRIPTION_API_URL"),
        )
        if api_url:
            transcription["api_url"] = api_url
        shared_root_key = (
            "READ_PODCAST_TRANSCRIPTION_SHARED_AUDIO_ROOT"
            if "READ_PODCAST_TRANSCRIPTION_SHARED_AUDIO_ROOT" in os.environ
            else "PODCAST2MD_TRANSCRIPTION_SHARED_AUDIO_ROOT"
        )
        if shared_root_key in os.environ:
            transcription["shared_audio_root"] = os.environ[shared_root_key]

        openai_config = dict(transcription.get("openai", {}) or {})
        openai_env = {
            "api_base": "READ_PODCAST_TRANSCRIPTION_OPENAI_API_BASE",
            "model": "READ_PODCAST_TRANSCRIPTION_OPENAI_MODEL",
            "language": "READ_PODCAST_TRANSCRIPTION_OPENAI_LANGUAGE",
            "timeout": "READ_PODCAST_TRANSCRIPTION_OPENAI_TIMEOUT",
            "max_upload_bytes": "READ_PODCAST_TRANSCRIPTION_OPENAI_MAX_UPLOAD_BYTES",
        }
        for config_key, env_name in openai_env.items():
            if env_name in os.environ:
                value = os.environ[env_name]
                openai_config[config_key] = (
                    int(value) if config_key in {"timeout", "max_upload_bytes"} else value
                )
        self_contained_env = "READ_PODCAST_TRANSCRIPTION_OPENAI_SELF_CONTAINED"
        if self_contained_env in os.environ:
            openai_config["self_contained"] = os.environ[self_contained_env].strip().lower() in {
                "1", "true", "yes", "on"
            }
        transcription["openai"] = openai_config
        self.TRANSCRIPTION_CONFIG = transcription
        self.REFINER_CONFIG = self._raw_config.get('refiner', {})
        self.RUNTIME_CONFIG = self._raw_config.get('runtime', {})
        self.WEB_CONFIG = self._raw_config.get('web', {})
        self.MLX_CONFIG = self._raw_config.get('mlx', {})

        # --- [3. 播客列表] ---
        self.PODCASTS = self._raw_config.get('podcasts', [])

        # --- [4. Prompt 模板列表] ---
        self.PROMPT_TEMPLATES = self._raw_config.get('prompt_templates', [])

        # --- [5. 文件连接器] ---
        self.CONNECTORS = self._raw_config.get('connectors', [])

    def get_podcast_dir(self, podcast_name, sub_type='markdown'):
        mapping = {
            'downloads': 'downloads',
            'transcripts': 'transcripts',
            'markdown': 'markdown'
        }
        dir_name = mapping.get(sub_type, sub_type)

        if sub_type == 'markdown' and self.OBSIDIAN_MARKDOWN_DIR:
            target_dir = self.OBSIDIAN_MARKDOWN_DIR
            try:
                target_dir.mkdir(parents=True, exist_ok=True)
            except (PermissionError, OSError) as e:
                logger.warning("无法创建 Obsidian Markdown 目录 %s (%s)，已自动降级回退至本地工作区", target_dir, e)
                target_dir = self.PROJECT_ROOT / "workspace" / podcast_name / dir_name
                target_dir.mkdir(parents=True, exist_ok=True)
        else:
            target_dir = self.PROJECT_ROOT / "workspace" / podcast_name / dir_name
            target_dir.mkdir(parents=True, exist_ok=True)

        return target_dir

    def _to_abs_path(self, path_str):
        p = Path(path_str).expanduser()
        if p.is_absolute():
            return p
        return (self.PROJECT_ROOT / p).absolute()

    def get_podcast_config(self, podcast_name):
        for p in self.PODCASTS:
            if p.get('name') == podcast_name:
                return p
        return None

settings = Settings()
