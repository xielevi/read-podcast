# 模块参考（modules/）

`modules/` 是与 Web 层解耦的业务核心：RSS 解析、音频下载、转录客户端、AI 精修、格式化与分阶段流水线。WebUI 与维护脚本都复用这里的实现。

## config.py — 配置管理

`Settings` 单例（`settings`）在导入时加载配置。普通配置优先级：`config/config.yaml` 用户覆盖 > `config.default.yaml` 默认值。Prompt 模板按 `name` 合并，本地覆盖同名模板并保留默认模板。环境变量用于选择配置路径、输出目录和提供凭据。

- 配置文件路径：`READ_PODCAST_CONFIG` 环境变量，否则 `PROJECT_ROOT/config/config.yaml`；容器内固定为 `/config/config.yaml`。覆盖文件可以为空，只需写偏离默认值的字段与 WebUI 订阅。
- YAML 规范命名空间为 `read-podcast:`，同时兼容顶层结构和旧 `podcast2md:` 命名空间。
- 机密文件：与 `config.yaml` 同目录的 `secrets.env`（WebUI 设置面板写入，权限 0600）在启动时补进环境变量；已存在的非空环境变量（Compose / `.env`）优先级更高，不会被覆盖。被补进来的变量名记在 `settings.MANAGED_SECRET_KEYS`，只有它们允许被面板改写。
- `settings.reload()` 重新读取持久化配置并刷新进程内设置，`settings.get_value('a.b.c')` 按点号路径读取合并后的值，供设置面板回显。

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

## user_settings.py — WebUI 个人配置面板

`/settings` 系列接口的读写逻辑，供用户在网页里改服务商地址、模型、密钥与文件位置。

- `FIELDS` 是显式白名单（三组：`refiner` / `transcription` / `paths`），每个字段声明类型、范围、提示与「哪些环境变量会接管它」；不开放任意 YAML 编辑。
- `describe_settings()` 回传字段、当前值与 `locked` 状态；机密只回传 `configured` 布尔值，**任何时候都不回传内容**。
- `apply_settings(values, secrets)` 逐字段校验（URL 必须 http(s)、数值范围、下拉可选项、目录可创建可写），普通配置原子写入 `config.yaml`（空值＝删除覆盖项，回落内置默认值），机密原子写入 `config/secrets.env`（0600）并同步注入 `os.environ`，最后 `settings.reload()` 热生效。被环境变量接管的字段直接拒绝并返回可读原因。
- `probe_refiner()` / `probe_transcription()` 做只读预检：前者发一次 16 token 的对话请求，后者按后端请求 `/health` 或 `/models`；失败信息经 `_redact()` 剥离服务地址后抛出。

## rss_parser.py — RSS 解析

`RSSParser(rss_url, name, insecure_tls=False).fetch_episodes(limit, min_duration_seconds, reverse, filter_id, filter_title)` 默认校验 TLS；仅订阅显式开启 `insecure_tls` 时，证书错误才会降级重试。其余行为基于 `feedparser` 抓取并清洗节目：剥离 HTML 的简介、提取 enclosure 音频链接、解析 `itunes:duration`。抓取时顺带记录频道封面到 `channel_image`（`itunes:image` 优先，零额外网络请求），供添加订阅时作为封面图回退。

## downloader.py — 音频下载

`Downloader(download_dir).download_audio(url, filename_base)`：优先直链 HTTP 流式下载（写 `.part` 后原子重命名），失败回退 `yt-dlp`；已存在且大于 100KB 时跳过。保留源音频格式，不强制转码。出站 URL 与每次重定向必须解析到公网地址，下载大小和执行时长受 `runtime.max_download_bytes` / `runtime.download_timeout_seconds` 限制。

## transcriber.py — 可插拔转录后端

`BaseTranscriber` 抽象基类统一 `transcribe(audio_file, cache_path, progress_callback)` 契约，返回统一的 `TranscriptionResult`。缓存命中/原子写入由模块级 `_read_cached_result` / `_write_cache` 共用。后端由 `transcription.backend` 选择，`get_transcriber(config)` 为工厂：

- **`mlx-api`（默认）—— `WhisperApiTranscriber`**：调用原生 MLX Whisper 服务，仅 Apple Silicon。
  - 共享路径模式（`transcription.shared_audio_root`）：POST `/transcribe-path` 传相对路径；服务端不支持或拒绝共享路径（403/404/405/501）时自动回退 multipart `/transcribe` 上传。
  - 转录请求带短期 request ID，并轮询 MLX `/progress/{request_id}`；后端按分片处理时 `progress_callback` 收到分片进度，进度接口不可用时不影响主请求。
  - Bearer Token（`READ_PODCAST_WHISPER_API_TOKEN`）鉴权。
- **`openai-api` —— `OpenAITranscriber`**：调用任意 OpenAI 兼容的 `/audio/transcriptions` 接口（OpenAI、Groq、自建 faster-whisper-server 等），**与平台无关**，可在 Windows / Linux / Intel Mac 运行，无需本机 MLX 进程。
  - 地址与模型来自 `transcription.openai.{api_base,model,language,timeout,max_upload_bytes,self_contained}`；Key 只从 `READ_PODCAST_TRANSCRIPTION_API_KEY` 注入。
  - `docker-compose.self-contained.yml` 会把该客户端指向仓库内 `services/builtin_transcription` 的 Faster-Whisper CPU 服务。转录运行时与 Web 应用镜像/进程隔离，模型缓存持久化到独立 volume。
  - `max_upload_bytes>0` 时对超限文件明确失败并提示改用自建服务；云端接口通常限制 25MB。
  - 支持 `response_format=json`（取 `text`）与纯文本响应两种返回。

`describe_transcriber(config)` 只返回安全元数据（`backend`/`engine`/`device`/`model`/`self_contained`），不含 URL、路径或凭据，供状态接口使用；外部 `openai-api` 默认 `self_contained=False`，只有内置 Compose 模式明确设为 `True`。未知 `backend` 会明确报错。

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

## library_qa.py — 跨节目问答检索

零依赖的关键词检索，支撑“跨多期播客提问”。`question_tokens` 把问题拆成 ASCII 词 + 过滤停用字后的中文二元组；`score_episode` 按标题（高权重）与正文中 token 命中数打分（有界扫描与计数上限）；`wants_recency` 识别“最近/近期/最新”等新近意图。`build_library_context(question, episodes, ...)` 在相关度排序与新近排序（问题过泛或强新近意图时）之间选择，挑出至多 `max_episodes` 期，从每期抽取包含命中 token 的窗口片段（无命中回退开头），拼成带 `【序号】` 来源标注的上下文，返回 `LibraryContext`（`context`/`sources`/`truncated`/`used_count`）。不使用向量库或外部服务，确定性、可测试。

## formatter.py — Markdown 格式化

`Formatter(markdown_dirs)`：`format_markdown(episode, transcript_text, tags, processing)` 生成 YAML frontmatter（含 `refinement_success`、`transcript_source`）+ 正文；`save_note(content, filename, target_dir)` 写入目标目录，权限失败时降级到 `workspace/<podcast>/markdown`。`strip_leading_frontmatter` 防止精修稿自带 frontmatter 冲突。

## utils/ — 通用工具

- `runtime.py`：`setup_logging`、`check_environment`、`datetime_to_str`，并保留 macOS Homebrew PATH 注入。
- `state.py`：`StateManager`（已处理节目 ID 集合，文件锁 + 原子写）与 `acquire_lock`。
- `quality.py`：`verify_refinement_quality(md, raw_text, min_output_ratio=0.9)`、`count_meaningful_chars` 与质量特征。
- `metadata.py`：`extract_metadata_from_text`（识别主播/嘉宾）与 `extract_frontmatter`；`utils/__init__.py` 保留兼容导出。

## connectors.py — 文件连接器

把成稿推送到**群机器人 Webhook** 或**云文档知识库**，**代码不硬编码任何提供商**：连接器只在配置声明 `name`/`format` 与承载凭据的环境变量名，真实凭据只从环境变量读取。

- `available_connectors(config)`：返回 `name`/`format`/`kind`（webhook|doc）/`configured`，按格式判断所需环境变量（webhook 需 `url_env`；notion 需 `token_env`+`database_id`/`page_id`；feishu-doc 需 `app_id_env`+`app_secret_env`；gdrive 需 `client_id_env`+`client_secret_env`+`refresh_token_env`），不暴露任何地址/凭据。
- `build_payload(fmt, doc, max_chars)`：Webhook 四种格式（feishu/dingtalk/slack/markdown）的请求体，正文按上限裁剪。
- `send_document(connector, doc)`：按 `format` 分派。Webhook→单次 POST；`notion`→`POST /v1/pages`（首批 90 块随页面创建，其余 `PATCH /v1/blocks/{id}/children` 分批追加）；`feishu-doc`→换取 `tenant_access_token`→建 Docx→按语义映射为标题（block_type 3/4/5）、无序列表（12）、文本（2）块，每批 50 个分批插入；`gdrive`→用刷新令牌换访问令牌→multipart 上传（`gdoc` 提交 HTML 请求转换成原生 Google 文档，`markdown` 存 `.md`）。整篇块数上限 `_MAX_DOC_BLOCKS_TOTAL`（2000），超出才标记 `truncated`。所有出站地址先过 `validate_public_url`（SSRF）；HTTP 非 2xx 或飞书/Notion/Google 业务错误码非 0 抛 `ConnectorError`（不记录地址与响应正文）。
- `test_connector(connector)`：只读预检——Notion 打 `/v1/users/me`，飞书换 token，Google Drive 换令牌后打 `/drive/v3/about`，Webhook 只校验已配置且公网可达。

## wikipedia.py — 关键概念 → 维基百科

从一篇文字稿里挑出 5–10 个值得延伸阅读的关键概念，并给出**经过核对**的维基百科链接。分两段是因为：AI 擅长判断「哪些词值得查」，但不能信任它给出的 URL（模型会编造看似合理却不存在的词条地址），所以链接一律由维基百科 API 返回的规范标题生成。

- `propose_concepts(...)`：用 `chat_completion` 让模型提名候选词（多提名一倍以抵消核对淘汰），`_parse_candidates` 容忍 ```json 围栏与前后散文，并按大小写去重。
- `lookup_concept(client, term, lang, fallback_lang)`：先按词条名直查 `/api/rest_v1/page/summary/`（自动跟随重定向），不中再退到 `list=search`，且搜索结果须过 `_titles_related`（归一化后互为子串且长度比 ≥0.6）才接受——全文搜索对任何词都会返回结果，这道校验挡住「阿尔法折叠→CASP」这类错误链接。消歧义页丢弃；主语言不中按 `fallback_lang` 回退。
- `collect_concepts(...)`：编排两段，线程池并发核对但按候选顺序收集以保留 AI 给出的重要性排序，再按「语言+规范标题」去重并截到 `limit`。返回 `concepts`（含 `term`/`reason`/`wikipedia_title`/`url`/`summary`/`lang`）与 `proposed`。语言代码只接受 `^[a-z]{2,3}(-[a-z]{2,8})*$`，站点地址由代码拼装。
- `concepts_to_markdown(concepts)`：渲染成「延伸阅读」列表，供附在导出正文后。

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
