# 模块参考（modules/）

`modules/` 是与 Web 层解耦的业务核心：RSS 解析、音频下载、转录客户端、AI 精修、格式化与分阶段流水线。WebUI 与维护脚本都复用这里的实现。

## config.py — 配置管理

`Settings` 单例（`settings`）在导入时加载配置。普通配置优先级：`config/config.yaml` 用户覆盖 > `config.default.yaml` 默认值。Prompt 模板按 `name` 合并，本地覆盖同名模板并保留默认模板。环境变量用于选择配置路径、输出目录和提供凭据。

- 配置文件路径：`READ_PODCAST_CONFIG` 环境变量，否则 `PROJECT_ROOT/config/config.yaml`；容器内固定为 `/config/config.yaml`。覆盖文件可以为空，只需写偏离默认值的字段与 WebUI 订阅。
- YAML 规范命名空间为 `read-podcast:`，同时兼容顶层结构和旧 `podcast2md:` 命名空间。

环境变量仅保留：

| 变量 | 作用 |
| :--- | :--- |
| `READ_PODCAST_CONFIG` | 配置文件路径 |
| `READ_PODCAST_OUTPUT_DIR` | Markdown 输出目录；Docker Compose 默认指向 `/data/output`，本机直接运行时留空 |
| `READ_PODCAST_WHISPER_API_TOKEN` | 转录服务 Bearer Token |
| `REFINER_API_KEY` | AI 精修 API Key |
| `READ_PODCAST_BASIC_AUTH_USERNAME` / `_PASSWORD` | 可选 Web Basic Auth 凭据 |

配置主要字段：`paths.*`、`runtime.*`、`web.*`、`mlx.*`、`transcription`、`refiner`、`podcasts[]`、`prompt_templates[]`。
`get_podcast_dir(name, sub_type)` 自动创建目录；Obsidian 目录权限不足时降级回 `workspace/<podcast>/markdown`。

## rss_parser.py — RSS 解析

`RSSParser(rss_url, name, insecure_tls=False).fetch_episodes(limit, min_duration_seconds, reverse, filter_id, filter_title)` 默认校验 TLS；仅订阅显式开启 `insecure_tls` 时，证书错误才会降级重试。其余行为基于 `feedparser` 抓取并清洗节目：剥离 HTML 的简介、提取 enclosure 音频链接、解析 `itunes:duration`。

## downloader.py — 音频下载

`Downloader(download_dir).download_audio(url, filename_base)`：优先直链 HTTP 流式下载（写 `.part` 后原子重命名），失败回退 `yt-dlp`；已存在且大于 100KB 时跳过。保留源音频格式，不强制转码。出站 URL 与每次重定向必须解析到公网地址，下载大小和执行时长受 `runtime.max_download_bytes` / `runtime.download_timeout_seconds` 限制。

## transcriber.py — 可插拔转录后端

`BaseTranscriber` 抽象基类统一 `transcribe(audio_file, cache_path, progress_callback)` 契约，返回统一的 `TranscriptionResult`。缓存命中/原子写入由模块级 `_read_cached_result` / `_write_cache` 共用。后端由 `transcription.backend` 选择，`get_transcriber(config)` 为工厂：

- **`mlx-api`（默认）—— `WhisperApiTranscriber`**：调用原生 MLX Whisper 服务，仅 Apple Silicon。
  - 共享路径模式（`transcription.shared_audio_root`）：POST `/transcribe-path` 传相对路径；服务端不支持或拒绝共享路径（403/404/405/501）时自动回退 multipart `/transcribe` 上传。
  - 转录请求带短期 request ID，并轮询 MLX `/progress/{request_id}`；后端按分片处理时 `progress_callback` 收到分片进度，进度接口不可用时不影响主请求。
  - Bearer Token（`READ_PODCAST_WHISPER_API_TOKEN`）鉴权。
- **`openai-api` —— `OpenAITranscriber`**：调用任意 OpenAI 兼容的 `/audio/transcriptions` 接口（OpenAI、Groq、自建 faster-whisper-server 等），**与平台无关**，可在 Windows / Linux / Intel Mac 运行，无需本机 MLX 进程。
  - 地址与模型来自 `transcription.openai.{api_base,model,language,timeout,max_upload_bytes}`；Key 只从 `READ_PODCAST_TRANSCRIPTION_API_KEY` 注入。
  - `max_upload_bytes>0` 时对超限文件明确失败并提示改用自建服务；云端接口通常限制 25MB。
  - 支持 `response_format=json`（取 `text`）与纯文本响应两种返回。

`describe_transcriber(config)` 只返回安全元数据（`backend`/`engine`/`device`/`model`/`self_contained`），不含 URL、路径或凭据，供状态接口使用；`openai-api` 后端 `self_contained=True`。未知 `backend` 会明确报错。

## refiner.py — AI 精修（OpenAI 兼容）

`OpenaiCompatRefiner(config).call(prompt, text_content, progress_callback)` 调用任意 OpenAI 兼容 Chat Completions API。

- 提供商、模型与普通参数：`refiner.*` 配置。
- API Key 来源：仅 `REFINER_API_KEY`。
- 指数退避重试（`max_retries`）；401/400 不重试；429 退避。
- `extract_markdown` 从返回中提取 Markdown 代码块。
- 针对 deepseek thinking 模型禁用 reasoning 以直接获取 content。
- 更换提供商只需在 `config/config.yaml` 覆盖 `refiner.api_base` / `refiner.model`；Key 仍放 `.env`。

同一模块还提供 AI 阅读助手复用的通用能力（同样只依赖 refiner 配置与 `REFINER_API_KEY`）：

- `chat_completion(messages, config, *, max_tokens, temperature)`：通用 OpenAI 兼容对话补全，返回纯文本；失败抛 `AssistantError`（401/400 不重试，429 退避）。供百科查询与文字稿问答复用。
- `assistant_available(config)`：判断助手是否可用（需 `api_base`、`model` 与 `REFINER_API_KEY` 齐备），供状态接口与前端优雅降级。

## formatter.py — Markdown 格式化

`Formatter(markdown_dirs)`：`format_markdown(episode, transcript_text, tags, processing)` 生成 YAML frontmatter（含 `refinement_success`、`transcript_source`）+ 正文；`save_note(content, filename, target_dir)` 写入目标目录，权限失败时降级到 `workspace/<podcast>/markdown`。`strip_leading_frontmatter` 防止精修稿自带 frontmatter 冲突。

## utils/ — 通用工具

- `runtime.py`：`setup_logging`、`check_environment`、`datetime_to_str`，并保留 macOS Homebrew PATH 注入。
- `state.py`：`StateManager`（已处理节目 ID 集合，文件锁 + 原子写）与 `acquire_lock`。
- `quality.py`：`verify_refinement_quality(md, raw_text, min_output_ratio=0.9)`、`count_meaningful_chars` 与质量特征。
- `metadata.py`：`extract_metadata_from_text`（识别主播/嘉宾）与 `extract_frontmatter`；`utils/__init__.py` 保留兼容导出。

## pipeline.py — 业务流水线（核心）

`PodcastPipeline` 是 RSS 单集处理的唯一业务实现（见架构决策）。阶段化、可被 WebUI 与维护脚本复用。

`EpisodeWork` dataclass 贯穿各阶段：

1. `prepare_episode(podcast_name, episode_title, force, progress_callback)`：解析 RSS 定位单集；若原始转录缓存 `*_raw.txt` 已存在则跳过下载；否则下载源音频。
2. `transcribe(work, progress_callback)`：缓存命中即跳过，否则调用 transcriber；空结果抛 `PipelineError`。
3. `refine(work, skip_refine, progress_callback)`：用 `refiner.build_refine_prompt` 从 `refiner.refine_prompt` 配置（含 `{summary}` 占位符，替换为节目简介）构建 prompt；调用 refiner；通过 `verify_refinement_quality`（比例 ≥0.9）门禁，未通过则回退原始转录。
4. `finalize(work)`：格式化并写入 Markdown；**只有输出文件真实存在才标记成功**，并登记已处理 ID。

`run_episode(...)` 串联上述阶段。`fetch_episodes`、`podcast_config`、`enabled_podcast_names` 为辅助方法。

> 维护脚本 `scripts/reprocess.py` 提供 `single` / `batch` 两种模式，并复用同一精修与质量门禁实现，不参与 Web 任务。

## audio_cleanup.py — 音频保留期清理

`cleanup_expired_audio(project_root, upload_dir, download_dir, retention_days=7)`：扫描上传目录、下载目录及 `workspace/*/downloads`，按 `mtime` 删除超过保留期的音频（扩展名白名单）。返回删除统计。失败任务的音频不在此处立即删除，而是由保留期统一回收，使重试可从最近阶段继续。
