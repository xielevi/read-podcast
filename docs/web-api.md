# Web 层与脚本（app/、scripts/）

## app/standalone.py — 应用入口

`app.standalone:app` 是唯一运行入口。FastAPI `lifespan` 中：初始化数据库、执行一次音频清理、启动周期清理任务（`runtime.cleanup_interval_seconds`，默认 86400s；`runtime.audio_retention_days`，默认 7 天）。

中间件 `web_access_middleware`：
- 反向代理保留前缀时剥离 `web.base_path`（设置 `root_path`），剥离前缀的代理无需配置。
- 可选 Basic Auth：`READ_PODCAST_BASIC_AUTH_USERNAME` 与 `READ_PODCAST_BASIC_AUTH_PASSWORD` 必须同时设置或同时留空（只设一个会启动失败）；健康检查路径始终免认证。
- GZip 中间件压缩大响应。

根路径 `/` 返回 `app/static/index.html`；相对资源 `/app.css` 与 `/app.js` 由同一入口提供，支持代理子路径。

## app/router.py — HTTP API

前缀 `/api/read-podcast`。`PublicTask` 模型仅暴露安全字段（不含 `log_path`、`output_path`），并包含经过脱敏的最后一条 `message`。

| 方法 | 路径 | 功能 |
| :--- | :--- | :--- |
| GET | `/health` | 健康检查，免认证 |
| GET | `/transcription/status` | 转录引擎安全元数据（含 `backend`/`self_contained`，不含 URL/Token/路径） |
| GET | `/subscriptions` | 当前播客订阅列表（含持久化的 `image` 封面图，若有） |
| GET | `/artwork` | SSRF 安全的封面图代理（`url` 参数；校验公网地址、限制类型 image/* 与体积 5MB，`Cache-Control` 一天） |
| GET | `/episodes` | 剧集列表（SWR 缓存，`X-Read-Podcast-Cache-State` 头标识 complete/stale/warming） |
| GET | `/search/podcast` | iTunes 检索 + 直连 RSS 解析 |
| POST | `/subscriptions` | 添加订阅（校验 RSS 可达，写入 `config.yaml` 顶层 `podcasts`，预热缓存；可选 `image` 封面图，缺省回退 RSS 频道封面） |
| DELETE | `/subscriptions/{name}` | 删除订阅（同步清理缓存） |
| POST | `/tasks` | 创建 RSS 单集任务 |
| POST | `/tasks/custom` | 创建自定义音频任务（prompt 必须来自预设模板，音频须在 uploads 内） |
| GET | `/tasks` | 任务列表（`PublicTask`，`limit` 默认 20、最大 200） |
| GET | `/tasks/completed-keys` | 全量成功稿件的节目/单集键与任务 ID |
| GET | `/tasks/{id}` | 任务状态（`PublicTask`） |
| DELETE | `/tasks/{id}` | 取消进行中任务；删除失败/取消记录（不删除音频、缓存或稿件） |
| POST | `/tasks/{id}/retry` | 使用保留的原音频重试失败/取消任务，并替换旧记录 |
| GET | `/tasks/{id}/stream` | SSE 实时日志流 |
| GET | `/tasks/stream` | 全部活跃任务的 SSE 多路复用流 |
| GET | `/tasks/{id}/content` | 读取输出文本（仅 `.md`/`.markdown`/`.txt`） |
| GET | `/tasks/{id}/download` | 下载输出文件 |
| POST | `/upload/audio` | 上传音频（扩展名白名单，`runtime.max_upload_bytes` 默认 2GiB；只返回文件名，不泄露绝对路径） |
| GET | `/prompt-templates` | 预设 Prompt 模板列表 |
| GET | `/assistant/status` | AI 助手是否可用（需配置 refiner 服务商与 `REFINER_API_KEY`），供前端优雅降级 |
| POST | `/assistant/lookup` | 百科查询：解释文字稿中的概念/人物/术语（`term`≤200，可选 `context`≤4000） |
| POST | `/tasks/{id}/chat` | 针对某份已完成文字稿的问答，回答严格基于文字稿内容（`question`≤2000，可带 `history`） |
| POST | `/assistant/library/chat` | 跨多期播客问答：从最近最多 60 期稿件中检索相关节目后综合作答，返回 `answer` 与带编号的 `sources` |
| GET | `/connectors` | 可用文件连接器清单（`name`/`format`/`kind`/`configured`，不含任何地址或凭据） |
| POST | `/tasks/{id}/export` | 把成稿推送到连接器（`connector` 名称 + `mode`：`manuscript` 整篇 / `summary` AI 知识条目） |
| POST | `/connectors/{name}/test` | 预检连接器凭据/可达性，不产生正式内容 |
| GET | `/settings` | 个人配置面板字段与当前取值（机密只回传 `configured`，不回传内容） |
| PUT | `/settings` | 保存个人配置：普通配置写 `config.yaml`，机密写 `config/secrets.env`，随后热重载 |
| POST | `/settings/test` | 预检 AI 服务商或转录服务可达性（`target`：`refiner` / `transcription`） |

订阅增删直接持久化到 `config.yaml`，重启后生效；写入逻辑与顶层/命名空间两种配置结构兼容。

**个人配置面板（`/settings`）** 让用户在网页里改服务商地址、模型、密钥与文件位置，无需登录服务器改文件。字段是显式白名单（`modules.user_settings.FIELDS`），不开放任意 YAML 编辑；普通配置写入持久化 `config.yaml`（空值表示删除覆盖项、回落内置默认值），机密写入同目录 `secrets.env`（0600）并同步注入当前进程，保存后 `settings.reload()` 立即生效。被环境变量接管的字段（如 Compose 注入的 `READ_PODCAST_TRANSCRIPTION_API_URL`、`READ_PODCAST_OUTPUT_DIR`）返回 `locked` 与原因，写入时返回 400。`GET` 绝不回传机密内容，只回传 `configured`；`POST /settings/test` 用一次极小的只读请求（refiner 走一次 16 token 对话，转录走 `/health` 或 `/models`）验证配置，失败信息剥离服务地址后以 502 返回。

**AI 阅读助手（`/assistant/*` 与 `/tasks/{id}/chat`）** 复用 refiner 段的 OpenAI 兼容服务商配置与 `REFINER_API_KEY`，不引入新的凭据来源。`chat` 端点读取任务输出文本（沿用与 `/content` 一致的路径与类型校验），剥离 frontmatter 后按 `ASSISTANT_CONTEXT_CHAR_BUDGET`（默认 24000 字符）截断灌入模型，只保留最近 `ASSISTANT_MAX_HISTORY`（默认 8）轮历史。未配置 AI 时返回 503 并附可读原因，前端据 `/assistant/status` 隐藏入口。

**跨节目问答（`/assistant/library/chat`）** 取最近 `LIBRARY_CORPUS_LIMIT`（默认 60）期已成功稿件，经 `modules.library_qa` 的零依赖关键词检索（ASCII 词 + 中文二元组打分、新近意图回退）挑出最相关的若干期，从每期抽取有界相关片段拼成带编号来源的上下文，再交给模型综合作答（要求标注各观点来自哪一期、点出共识与分歧、片段外内容不编造）。返回的 `sources` 含 `index`/`task_id`/`title`/`podcast`，前端渲染为可点击跳转到对应稿件的来源标签。稿件库为空时返回 404。

**文件连接器（`/connectors`、`/tasks/{id}/export`、`/connectors/{name}/test`）** 复用 `modules.connectors`，把成稿推送到两类目标：**群机器人 Webhook**（`feishu`/`dingtalk`/`slack`/`markdown`，声明 `url_env`）与**云文档知识库**（`notion` 在数据库/页面下建页，声明 `token_env`+`database_id`/`page_id`；`feishu-doc` 新建飞书 Docx，声明 `app_id_env`+`app_secret_env`）。所有凭据只从 `.env` 读取，`/connectors` 只回传 `format`/`kind`/`configured`，绝不暴露地址或凭据。

`export` 支持 `mode`：`manuscript` 推送整篇成稿；`summary` 先用 `chat_completion` 从文字稿提炼「核心观点/关键案例/知识点/延伸选题」的知识条目再推送（AI 未配置时 503）。所有出站请求经 `validate_public_url` 做 SSRF 校验，正文按目标上限裁剪、云文档结构化为标题/段落/列表块；飞书/钉钉/Notion 的业务错误码或非 2xx 视为失败并返回 502（脱敏）。`test` 端点对 Notion（`GET /v1/users/me`）与飞书（换取 `tenant_access_token`）做只读预检，Webhook 无只读预检口则只校验已配置且地址公网可达。

## app/tasks.py — 任务编排

`run_pipeline`（RSS 任务）与 `run_custom_pipeline`（自定义音频任务）实现分阶段资源控制：

- 下载：`_download_slots` 信号量，`runtime.download_concurrency`（默认 2）。
- Whisper：`_whisper_lock` 全局单请求，确保不争用 Metal。
- 精修：`_refine_slots` 信号量，`runtime.refine_concurrency`（默认 2）。

同步流水线在 `asyncio.to_thread` 中执行，`_thread_reporter` 将阶段事件回投事件循环，同步更新数据库与 SSE。任务会持久化阶段、百分比和脱敏进度消息；失败时保留最后一个真实进度，原音频不被删除。**只有输出文件真实存在才标记 SUCCESS**，否则标记 FAILED 并提供重试入口。自定义任务的音频与输出路径必须位于 `workspace` 内（沙箱校验）。

## app/sse.py — 实时日志

`Notifier` 维护任务级与全局订阅队列。`subscribe(task_id)` 生成 SSE 消息（`data: {json}\n\n`），事件包含脱敏的 `status`、`stage`、`progress` 和 `message`；收到 `level=done` 或 `level=error` 终止；`subscribe()` 为全部任务复用流，仅在客户端断开时结束。每 15 秒发送一次注释心跳，队列上限 200，满时丢弃最旧消息。模块级单例 `notifier`。

## app/database.py — 持久化

基于 `aiosqlite`，数据库位于 `workspace/podcast2md.db`。lifespan 持有单连接并在退出时关闭，启用 WAL 与 `busy_timeout=5000`。`save_task`（INSERT OR REPLACE）、`update_task`（增量更新，自动写 `updated_at`）、`get_task`、`list_tasks`（按 `created_at DESC`）。任务更新字段经过白名单校验。

## app/models/task.py — 数据模型

`TaskStatus` 枚举：`pending`/`running`/`success`/`failed`/`cancelled`。`Task`（Pydantic）字段：`id`、`podcast_name`、`episode_title`、`status`、`progress_pct`、`stage`、`message`、`output_path`、`created_at`、`updated_at`。

## scripts/mlx_backend.py — 原生 MLX Whisper 服务

在 macOS Apple Silicon 主机上原生运行（Docker 外），提供 Metal 加速转录。

- `GET /health`：返回引擎与模型状态。
- `POST /transcribe`：接收 multipart `file`，Bearer Token 鉴权，写入临时文件后转录并删除。
- `POST /transcribe-path`：接收共享根目录内的相对 `path`；服务端 `resolve` 后必须仍位于 `SHARED_AUDIO_ROOT` 且扩展名属于白名单，否则拒绝。未配置共享根时返回 404。
- `GET/DELETE /progress/{request_id}`：为 Web 客户端提供安全的分片完成度查询；清理接口只删除内存中的进度记录。
- JSON 响应会将 MLX 结果中的 `NaN`/`Infinity` 指标转换为 `null`，避免已完成的转录因非标准 JSON 失败。
- 单把 `_transcription_lock` 保证一次只跑一个完整转录请求；任务结束后按 `mlx.model_idle_seconds`（默认 300s，`0` 立即释放）保温模型，超时释放模型与 Metal cache；连续任务复用已加载模型。

普通参数来自 `mlx.*`；环境变量只保留 `READ_PODCAST_WHISPER_API_TOKEN`。

## services/builtin_transcription — 可选自包含转录服务

`docker-compose.self-contained.yml` 才会启动的独立 CPU 服务，不进入默认 Mac mini / MLX 路径。

- `GET /health`：返回引擎、模型、CPU 设备与是否已加载模型，不预加载模型。
- `GET /v1/models`：OpenAI 兼容模型列表；配置 Token 时要求 Bearer 鉴权。
- `POST /v1/audio/transcriptions`：OpenAI 兼容 multipart 接口，支持 `json` / `verbose_json` / `text`，文件流式落盘并受大小上限约束，转录后删除临时文件。
- 完整转录用单请求锁串行；Faster-Whisper 模型懒加载并在进程内复用。
- 模型文件保存在 `read-podcast-models` volume，容器重建不会丢失。服务不映射宿主端口。

## scripts/ 下的维护脚本

均为维护包装层，**不参与 Web 任务执行**：

- `podcast_pipeline.py`：CLI 批量处理（`--limit`/`--podcast`/`--title`/`--id`/`--dry-run`/`--force`/`--skip-refine`），文件锁防并发，调用 `PodcastPipeline`。
- `reprocess.py single`：对一份已缓存的 `*_raw.txt` 重新精修。
- `reprocess.py batch`：从 RSS 匹配元数据，批量重处理历史转录稿。
