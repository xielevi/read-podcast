# 架构

## 目标

将可移植的应用层与硬件相关的语音推理解耦：个人用户优先在 macOS 原生运行 Web 应用与 MLX Whisper；Docker 作为进阶部署方式，只容器化 Web 应用。两种方式共用代码和配置分层，用户只通过 WebUI 交互。

## 组件

```text
浏览器（根路径或子路径）
  │ HTTP + SSE
  ▼
Read Podcast Web :28000（原生）或 Docker :8080 → :28000
  ├─ FastAPI WebUI / API（可选 Basic Auth）
  ├─ 分阶段调度：下载 / 转录 / 精修
  ├─ RSS / 音频下载 / SQLite / workspace / output
  ├─ 转录后端（可插拔）
  │    ├─ mlx-api ────────▶ macOS 原生 MLX Backend :21567（Apple Silicon 默认）
  │    └─ openai-api ─────▶ OpenAI 兼容 /audio/transcriptions
  │         ├─ 仓库内置 Faster-Whisper 容器（CPU，可选自包含模式）
  │         └─ 用户自选云端 / 自建兼容服务
  ├─ Chat Completions ─────▶ OpenAI 兼容 Refiner（精修）
  ├─ AI 阅读助手 ──────────▶ 复用 Refiner 服务商（百科查询 / 单篇及跨节目问答）
  ├─ 封面图代理 ───────────▶ 第三方封面 CDN（SSRF 校验 + 体积/类型限制）
  └─ 文件连接器 ───────────▶ 飞书 / 钉钉 / Slack / 自建 Webhook（成稿外发）
```

## 运行边界

- 容器监听 `0.0.0.0:8080`，Compose 固定映射为宿主机 `127.0.0.1:28000`；需要其他暴露方式时显式调整 Compose。
- WebUI 是唯一用户入口，进程内直接调用 `modules.pipeline`；维护脚本不是对外产品界面。
- WebUI 自动继承浏览器可见 URL 前缀；保留前缀的代理通过 `web.base_path` 剥离。
- Basic Auth 默认关闭；同时配置用户名与密码后保护 WebUI 与业务 API，健康检查免认证。
- MLX 后端在原生一键模式默认只监听 `127.0.0.1:21567`。Docker 辅助模式需要监听宿主机网络，因此启动脚本强制要求 Bearer Token；容器经 `host.docker.internal` 访问。分离部署必须同时使用 Token 和可信网络限制。
- 下载与精修使用 `runtime.download_concurrency` / `runtime.refine_concurrency` 控制有限并发，Whisper 对外单请求；不同任务可跨阶段重叠。
- 同机部署提交 workspace 相对路径（`/transcribe-path`，服务端 allowlist 约束）；分离部署回退 multipart 上传。
- 运行数据全部位于 Compose 挂载的 `config/`、`workspace/`、`output/`；配置首次启动从镜像内置默认自动种子。

## HTTP 契约（MLX 后端）

- `GET /health`：引擎与模型状态。
- `POST /transcribe`：multipart `file`，返回含 `text` 的 JSON。
- `POST /transcribe-path`：共享根目录内的相对 `path`；未配置共享根时关闭。
- 配置 Token 后，`/transcribe*` 必须携带 `Authorization: Bearer <token>`；Docker 辅助模式不允许空 Token。
- multipart 上传受 `mlx.max_upload_bytes` 限制；客户端只能选择服务端配置的模型。

## 设计决策

> 以下为已采纳的架构决策摘要。

**D1 Apple Silicon 默认路径与推理进程隔离。** Linux 容器无法访问 macOS Metal，故 Mac mini 默认仍由 Apple Silicon 主机原生运行 MLX，应用通过 HTTP 调用。原生服务实现以本仓库 `scripts/mlx_backend.py` 为唯一事实源；主机基础设施仓库只保存 LaunchAgent 等部署配置，不复制服务代码。实验分支可额外提供独立的 CPU 转录容器，但推理运行时不进入 Web 应用镜像、不进入 Web 进程，也不自动探测或改写宿主硬件配置。

**D2 WebUI-only 与反向代理访问。** WebUI 是唯一正式入口，CLI 仅保留为维护包装层。Compose 默认只绑定回环地址。WebUI 按浏览器可见路径生成 API/SSE/上传/下载 URL，根路径与任意子路径共用同一镜像；保留前缀的代理用 `web.base_path`。默认无鉴权，可选 Basic Auth（用户名与密码同时设置），健康检查免认证，不开放跨域。

**D3 Web 原生分阶段流水线 + 共享音频路径。** `modules.pipeline.PodcastPipeline` 是唯一业务实现，WebUI 进程内调用并消费结构化阶段事件。下载/精修有限并发，Whisper 单请求，可跨阶段重叠。RSS enclosure 保留源格式，下载用临时文件 + 原子重命名。原始转录缓存命中则跳过下载与转录；音频由统一保留期清理，任务失败不立即删除。同机启用 `/transcribe-path` 提交相对路径，服务端 allowlist 解析；分离部署回退 multipart。转录失败必须使任务失败；只有输出文件真实存在才标记成功。MLX 分片并发默认降为 2，模型空闲保温后释放。

**D4 配置分层。** `modules/config.default.yaml` 保存普通运行默认值、Prompt 与空播客列表，持久化 `config/config.yaml` 保存用户覆盖和 WebUI 写入内容；机密统一写入 `config/secrets.env`（0600），**手动编辑与 WebUI 面板作用于同一文件**；根目录 `.env` 保留为向后兼容的旧位置与 Docker Compose 的 `${VAR}` 替换来源，优先级低于 `secrets.env`。Compose 只描述本地构建、端口、挂载、资源限制和凭据注入，不重复应用默认值。

**D5 本机原生部署为个人用户首选路径。** 面向非技术用户，`scripts/install.sh` 与 `scripts/start.sh` 在 macOS 上同时托管 MLX 后端与网页应用。Docker 保留为进阶备选，其网页应用镜像默认从 GHCR 拉取。两种路径下 MLX 均原生运行。启动入口通过环境覆盖确定模式：原生使用 `127.0.0.1:21567` 并关闭共享路径，Docker 使用 `host.docker.internal:21567` 与 `/app/workspace`；不会因持久化配置残留而串用地址。

**D6 出站网络与资源边界。** 用户提供的 RSS 和媒体 URL 仅允许 HTTP(S)，并在请求及重定向前解析 DNS、拒绝回环、私网、保留和链路本地地址。RSS、直接音频下载、yt-dlp 和 MLX 上传均有大小或超时限制。日志去除 URL 凭据、query 和供应商响应正文，避免签名参数与转录片段落盘。

**D8 可插拔转录后端与可选自包含模式（实验分支）。** `transcription.backend` 在 `mlx-api`（默认，保持原行为）与 `openai-api` 之间选择。`openai-api` 通过 `BaseTranscriber` 统一契约调用 OpenAI 兼容的 `/audio/transcriptions` 服务。该服务既可是 OpenAI、Groq 或用户自建服务，也可由仓库内的 `docker-compose.self-contained.yml` 启动 `services/builtin_transcription` CPU 容器提供。后者在 Linux x86-64 与 AArch64/ARM64 上使用 Faster-Whisper/CTranslate2，模型首次运行下载后持久化到独立 volume，不需要第三方转录 API Key。Web 应用与转录容器仍以 HTTP 分离，可独立替换、限流和回滚。后端地址、模型与是否自包含只从配置/部署环境读取，Key 只从 `READ_PODCAST_TRANSCRIPTION_API_KEY` 注入。`/transcription/status` 只返回不含 URL、Token 和路径的安全元数据，不再把任意外部 `openai-api` 误报为自包含。

**D9 AI 阅读助手复用精修服务商（实验分支）。** 百科查询（`/assistant/lookup`）、单篇文字稿问答（`/tasks/{id}/chat`）与跨节目问答（`/assistant/library/chat`）复用 refiner 段的 OpenAI 兼容配置与 `REFINER_API_KEY`，不引入新凭据来源。问答严格以文字稿为上下文（沿用 `/content` 的路径与类型校验，剥离 frontmatter 后按字符预算截断），指令要求“稿中无则如实说明、不得编造”。跨节目问答用 `modules.library_qa` 的零依赖关键词检索（不引入向量库或外部检索服务）从稿件库挑选相关节目、拼装带来源编号的上下文，答案标注来源并可点击跳转。未配置 AI 时端点返回 503 并附可读原因，前端据 `/assistant/status` 隐藏入口，保持核心转录流程不受影响。

**D10 封面合集与封面图代理（实验分支）。** 订阅持久化可选 `image` 封面图（搜索添加取 iTunes 封面，直连 RSS 回退频道 `itunes:image`，抓取节目时零额外请求记录）。前端在订阅页拼出杂志式封面合集。所有第三方封面图统一经 `/artwork` 服务端代理加载：`validate_public_url` 做 SSRF 校验、限制 `image/*` 类型与 5MB 体积、带一天缓存，浏览器不直连第三方 CDN，符合 D6 出站边界。

**D11 文件连接器（实验分支）。** `/tasks/{id}/export` 经 `modules.connectors` 把成稿推送到两类目标：**群机器人 Webhook**（飞书/钉钉/Slack/通用 JSON）与**云文档知识库**（`notion` 建页、`feishu-doc` 建飞书 Docx、`gdrive` 建 Google 文档）。与 refiner/transcriber 一致：代码不硬编码提供商，连接器只在配置声明 `name`/`format` 与凭据环境变量名，真实凭据只从 `.env` 或 D14 的本机机密文件注入，`/connectors` 只回传 `kind`/`configured`、不暴露地址或凭据。`export` 的 `mode=summary` 复用 `chat_completion` 先提炼知识条目再推送，实现「把播客沉淀成知识库」。所有出站请求 SSRF 校验、按目标上限裁剪并结构化为文档块；失败（HTTP 非 2xx 或业务错误码）返回 502 并脱敏。`/connectors/{name}/test` 做只读预检。长文档**分批写入而非截断**（飞书每批 50 块、Notion 首批 90 块后 `PATCH` 追加），整篇设 2000 块护栏。仅用各家的简单 HTTP/JSON 接口，不引入 SDK 依赖：手工飞书连接器继续支持 `tenant_access_token`，OAuth 内置连接器使用并刷新用户身份令牌；Google Drive 用刷新令牌换访问令牌后 multipart 上传。Google 不用服务账号，因为个人账号下服务账号没有独立存储配额且文件不归属用户本人。

**D13 关键概念只给经核对的维基百科链接。** `POST /tasks/{id}/concepts` 分两段：AI 只从文字稿**提名**候选词，链接一律由维基百科 API 返回的规范标题生成——**模型给出的 URL 一概不采信**，因为模型会编造看似合理却不存在的词条地址。核对先按词条名直查摘要接口（自动跟随重定向），不中再退到全文搜索，且搜索结果须通过标题相关性校验（归一化后互为子串且长度比 ≥0.6）才接受；全文搜索对任何词都会返回结果，这道校验挡住「阿尔法折叠→CASP」这类沾边错链。核对不到或落到消歧义页的候选直接丢弃，因此返回条数常少于 `limit`——**宁可少给，也不给错链接**。复用 refiner 的服务商配置与 `REFINER_API_KEY`，不引入新凭据来源；语言代码经正则约束、站点地址由代码拼装，不接受外部主机名。抽取成本较高（一次 AI + 若干次查询），故由用户显式触发并按「任务 + 输出文件 mtime」缓存，不在流水线里自动跑，保持 D1 的转录主流程不受影响。

**D12 WebUI 个人配置面板。** 分层不变（D4）：普通配置写入持久化 `config/config.yaml`，机密写入同目录的 `secrets.env`（0600，随 `config/` 卷持久化），二者都不进镜像、不进版本库。`Settings` 启动时把 `secrets.env` 补进环境变量，**只有部署方从外部注入的环境变量**（Compose / shell，即 Python 进程启动前就存在的，由 `EXTERNAL_ENV_KEYS` 在 `load_dotenv()` 之前快照记录）才标记 `locked` 并拒绝写入。`.env` 里的值**不锁定面板**——它和 `secrets.env` 一样只是本机文件，若也锁死，用户按 README 把 Key 填进 `.env` 后就会发现最想改的字段恰恰在网页上改不了。同理 `secrets.env` 优先级高于 `.env`，否则面板保存的新 Key 会被旧值静默盖掉。面板只暴露显式白名单字段（refiner 服务商与参数、transcription 后端与地址、成稿与下载目录），不开放任意 YAML 编辑；保存后调用 `settings.reload()` 热生效，进程启动时读取的运行参数（并发、保留期）不进入面板。`GET /settings` 只回传「是否已配置」，任何时候都不回传机密内容；`POST /settings/test` 用一次极小的只读请求验证服务商可达性，失败信息剥离服务地址后返回。

**D14 云文档账号 OAuth。** 左栏 Google 文档与飞书文档入口是独立的账号连接流程，不再跳转通用设置面板。首次连接时，用户在专用抽屉填写各自开发者应用的 Client/App ID 与 Secret；服务端只回传「应用凭据是否已配置」「账号是否已连接」，机密沿用 D12 写入 `config/secrets.env`（0600），绝不回显。授权采用服务端 Authorization Code Flow：Google 请求 `drive.file` 与离线访问，飞书请求用户身份授权；回调必须校验一次性、十分钟过期的 `state`，并且 `redirect_uri` 必须与发起请求同源且路径严格匹配当前 API 回调。刷新令牌只在服务端保存，浏览器不接触 token；回调页仅向同源 opener 发送成功/失败状态后关闭。账号连接后，内置 Google/飞书连接器自动出现；显式 `connectors` 配置仍优先，保持旧 tenant token 与手工刷新令牌配置兼容。OAuth 应用未配置时前端必须显示凭据表单，不能伪装成可直接登录。


**D7 品牌与兼容标识。** 项目品牌统一为 Read Podcast，规范技术标识为 `/api/read-podcast`、`READ_PODCAST_*`、`read-podcast:` 与 `X-Read-Podcast-*`。既有 `/api/podcast2md`、`PODCAST2MD_*`、`podcast2md:`、`X-Podcast2MD-*` 和 `workspace/podcast2md.db` 只作为隐藏兼容接口继续保留，避免升级破坏现有配置、客户端与任务数据。

## 容错

- 转录失败进入任务错误状态，不伪装成功；原始转录原子缓存，重跑可跳过下载与转录。
- 下载音频保留源格式并由保留期清理；任务失败不立即删除，便于从最近阶段重试。
- 精修未通过长度（非空白字符 ≥90%）与结构门禁时回退原始转录。
- SSE 中断后前端降级轮询任务状态；Markdown 读取接口不返回服务器绝对路径。
- WebUI、API、SSE、上传与下载同源，不开放跨域 API。
