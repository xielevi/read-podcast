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
  ├─ 分阶段调度：下载 / Whisper / 精修
  ├─ RSS / 音频下载 / SQLite / workspace / output
  ├─ 共享路径或 HTTP ──────▶ macOS 原生 MLX Backend :21567
  └─ Chat Completions ─────▶ OpenAI 兼容 Refiner
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

**D1 Docker 应用 + 原生 MLX 后端分离。** Linux 容器无法访问 macOS Metal，故 MLX 在 Apple Silicon 主机上原生运行，应用通过 HTTP 调用。原生服务实现以本仓库 `scripts/mlx_backend.py` 为唯一事实源；主机基础设施仓库只保存 LaunchAgent 等部署配置，不复制服务代码。GitHub 只发布不含模型与推理运行时的应用镜像。不引入 Faster-Whisper、自包含 CPU 镜像或宿主硬件自动选型。

**D2 WebUI-only 与反向代理访问。** WebUI 是唯一正式入口，CLI 仅保留为维护包装层。Compose 默认只绑定回环地址。WebUI 按浏览器可见路径生成 API/SSE/上传/下载 URL，根路径与任意子路径共用同一镜像；保留前缀的代理用 `web.base_path`。默认无鉴权，可选 Basic Auth（用户名与密码同时设置），健康检查免认证，不开放跨域。

**D3 Web 原生分阶段流水线 + 共享音频路径。** `modules.pipeline.PodcastPipeline` 是唯一业务实现，WebUI 进程内调用并消费结构化阶段事件。下载/精修有限并发，Whisper 单请求，可跨阶段重叠。RSS enclosure 保留源格式，下载用临时文件 + 原子重命名。原始转录缓存命中则跳过下载与转录；音频由统一保留期清理，任务失败不立即删除。同机启用 `/transcribe-path` 提交相对路径，服务端 allowlist 解析；分离部署回退 multipart。转录失败必须使任务失败；只有输出文件真实存在才标记成功。MLX 分片并发默认降为 2，模型空闲保温后释放。

**D4 配置分层。** `config.default.yaml` 保存普通运行默认值、Prompt 与空播客列表，持久化 `config/config.yaml` 保存用户覆盖和 WebUI 写入内容；`.env` 只保存 API Key、Token 与 Basic Auth 凭据。Compose 只描述本地构建、端口、挂载、资源限制和凭据注入，不重复应用默认值。

**D5 本机原生部署为个人用户首选路径。** 面向非技术用户，`scripts/install.sh` 与 `scripts/start.sh` 在 macOS 上同时托管 MLX 后端与网页应用。Docker 保留为进阶备选，其网页应用镜像默认从 GHCR 拉取。两种路径下 MLX 均原生运行。启动入口通过环境覆盖确定模式：原生使用 `127.0.0.1:21567` 并关闭共享路径，Docker 使用 `host.docker.internal:21567` 与 `/app/workspace`；不会因持久化配置残留而串用地址。

**D6 出站网络与资源边界。** 用户提供的 RSS 和媒体 URL 仅允许 HTTP(S)，并在请求及重定向前解析 DNS、拒绝回环、私网、保留和链路本地地址。RSS、直接音频下载、yt-dlp 和 MLX 上传均有大小或超时限制。日志去除 URL 凭据、query 和供应商响应正文，避免签名参数与转录片段落盘。

**D7 品牌与兼容标识。** 项目品牌统一为 Read Podcast，规范技术标识为 `/api/read-podcast`、`READ_PODCAST_*`、`read-podcast:` 与 `X-Read-Podcast-*`。既有 `/api/podcast2md`、`PODCAST2MD_*`、`podcast2md:`、`X-Podcast2MD-*` 和 `workspace/podcast2md.db` 只作为隐藏兼容接口继续保留，避免升级破坏现有配置、客户端与任务数据。

## 容错

- 转录失败进入任务错误状态，不伪装成功；原始转录原子缓存，重跑可跳过下载与转录。
- 下载音频保留源格式并由保留期清理；任务失败不立即删除，便于从最近阶段重试。
- 精修未通过长度（非空白字符 ≥90%）与结构门禁时回退原始转录。
- SSE 中断后前端降级轮询任务状态；Markdown 读取接口不返回服务器绝对路径。
- WebUI、API、SSE、上传与下载同源，不开放跨域 API。
