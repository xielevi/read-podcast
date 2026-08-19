# Read Podcast 协作边界

## 架构约束

- 应用支持两种部署：macOS 本机原生运行（`scripts/start.sh` 一键脚本，面向个人用户的首选）与 Docker。二者共用同一套代码与配置分层。
- 转录后端通过 `transcription.backend` 选择：默认 `mlx-api`（macOS Apple Silicon 原生 MLX HTTP 服务，行为不变）；实验分支新增 `openai-api`，作为 OpenAI 兼容 `/audio/transcriptions` 的跨平台 HTTP 客户端，并可通过单独 Compose 覆盖文件启动仓库内置 Faster-Whisper CPU 服务（见 `docs/ARCHITECTURE.md` D8）。
- `mlx-api` 后端通过 `transcription.api_url` 访问 MLX 服务；本机原生默认 `127.0.0.1:21567`，Docker 默认 `host.docker.internal:21567`。
- Faster-Whisper 只能存在实验分支的独立转录服务镜像中；不进入 Web 应用镜像或 Web 进程。不加入宿主硬件自动选型或进程内 MLX。
- 架构变更必须先更新 `docs/ARCHITECTURE.md` 的设计决策小节。

## 运行边界

- 应用入口：`app.standalone:app`。本机原生启动经 `scripts/start.sh`（同时托管 MLX 后端），Docker 启动经 Compose。
- 用户交互入口仅为 WebUI；`scripts/podcast_pipeline.py` 只作为维护包装层，不参与 Web 任务执行。
- API 前缀：`/api/read-podcast`。
- WebUI 必须同时支持域名根路径和反向代理子路径。
- Web 侧鉴权仅使用可选 Basic Auth；默认关闭，不加入网关专属鉴权分支。
- 原生后端入口：`scripts/mlx_backend.py`。
- Web 任务使用分阶段资源控制：Whisper 对外保持单请求，下载与精修允许有限并发和跨任务重叠。
- 同机共享路径必须由 Whisper 服务端根目录 allowlist 约束；分离部署保留 multipart 上传回退。
- 失败任务不得删除仍在保留期内的音频；只有输出文件真实存在时才能标记成功。
- `workspace/`、`output/`、`config.yaml`、`config/secrets.env`、`.env`、数据库、音频和 Markdown 产物不得提交。
- 精修结果必须保留长度和结构门禁，失败时回退原始转录。
- 状态接口不得暴露 URL、Token、本机路径或其他凭据。`/settings` 是唯一例外：它回显用户自己填写的地址与目录，但同样绝不回传机密内容，只回传「是否已配置」。
- WebUI 可写配置只能走 `modules/user_settings.py` 的显式字段白名单，不开放任意 YAML 编辑；普通配置写 `config.yaml`，机密写同目录 `secrets.env`（0600），环境变量接管的字段必须拒绝写入。

## 验收

```bash
uv sync --dev
uv run pytest -q
docker build -t read-podcast:test .
```

至少验证：

- `GET /`、配置的子路径与 `GET /api/read-podcast/health` 返回 `200`。
- Basic Auth 关闭时不拦截；同时配置用户名和密码时保护 WebUI 与业务 API。
- `GET /api/read-podcast/transcription/status` 只返回安全元数据。
- `GET /api/read-podcast/settings` 不含任何机密内容；被环境变量接管的字段标记 `locked`，`PUT` 时返回 400。
- 原生 MLX 后端 `/health` 与带 Token 的 `/transcribe` 通过。
- 容器进入 `healthy`。
- 页面可以创建任务、接收 SSE 日志并打开生成稿件。
