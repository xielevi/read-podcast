# Read Podcast

[English](README.md) · **简体中文**

听过一集好播客，想回头找某段话，却不想再从头听一遍？Read Podcast 可以把你选中的单集整理成一篇有章节、能读下去的长稿，存成你自己保管的 Markdown。手机上读、搜索段落、分享公开页面，都可以。

<p align="center">
  <img src="docs/assets/readme/library.webp" alt="Read Podcast 的订阅与稿件工作区" width="920">
</p>

[本地试用](#本地试用) · [部署到 Cloudflare](docs/DEPLOYMENT.md#2-cloudflare-application) · [用 Docker 部署](docs/DEPLOYMENT.md#7-local-docker-deployment)

## 挑一集，留下全文

从 Apple Podcasts 搜索节目，粘贴 RSS 地址，或导入自己的音频（最多 200 MiB）。选好单集后手动开始生成；新单集不会自动转写。获取音频、转写、整理、保存的过程会显示进度，关掉浏览器也能继续。

整理时会删掉口语重复，留下对话中的推理、例子和细节。成稿有说话人和章节，适合连贯阅读。阅读器提供目录和排版设置，也能下载 Markdown。界面可切换中文和英文；编辑指令按音频内容语言选择，维基百科概念链接则跟随界面语言。你填写的自定义指令优先。

<p align="center">
  <img src="docs/assets/readme/reader.webp" alt="带目录的稿件阅读器" width="920">
</p>

Cloudflare 部署把已发布稿件放进你的 GitHub 仓库；Docker 默认保存在主机目录。应用负责索引与阅读页面，Markdown 留在你选定的稿件存储中。

## 部署在哪里

| | Cloudflare | Docker / Node |
|---|---|---|
| 应用与状态 | Worker、D1、Workflows、R2 | 单机、SQLite、本地文件 |
| 稿件 | 你的 GitHub 仓库 | 默认本地目录 |
| 转写 | 自建服务或配置云端后端 | Compose 内含 Faster-Whisper |
| 管理权限 | Cloudflare Access | 默认只监听本机，可启用 Basic Auth |

参考转写服务在 Apple Silicon 上运行 MLX Whisper；项目还实现了 Faster-Whisper、可选的 OpenAI 兼容上传代理，以及 Worker 端的百炼 DashScope 适配。第三方服务的可用性和费用取决于你自己的配置与账户，详见[部署指南](docs/DEPLOYMENT.md)。稿件整理需要 OpenAI 兼容的 LLM API。

维护者在 Workers Free 上运行 Cloudflare 版，但这不能证明所有工作负载都有充足的 CPU、子请求或 Workflow 余量。请按自己的用量核对[部署限制](docs/DEPLOYMENT.md#resource-names-and-free-plan-boundary-checks)；LLM 和云端转写可能另行计费。

这是单主人工作区。`/` 默认公开，访客能看到订阅和已发布稿件；如果这些也要保密，请保护整个域名。Cloudflare 自定义域名部署必须用 Access 保护 `/manage*` 和 `/api/control/*`；workers.dev 路径用 Basic Auth。Docker 默认只绑定本机。稿件由你逐集手动生成。

## 部署途径

1. **Deploy to Cloudflare** *(一键部署模板，草案 / 待实测验证)*：
   正式按钮须在独立账号完成首次部署验证后才会放到 README。
   > [!NOTE]
   > 一键部署模板已完成代码与配置准备，当前处于草案阶段，等待在全新 Cloudflare 账号中完成全流程实测验证后再正式对外推荐。测试时请务必填写 `CONTROL_AUTH_USER` 与 `CONTROL_AUTH_PASSWORD` 以保护控制面。
2. **`npm run setup`** *(推荐生产使用：自定义域名、Cloudflare Access 与 Tunnel)*：
   交互式幂等初始化脚本，自动创建资源并打印 Zero Trust 配置清单。详见[部署指南](docs/DEPLOYMENT.md#2-cloudflare-application)。
3. **Docker**：
   完全本地路径，使用本机算力与本地文件存储。详见 [Docker 路径](docs/DEPLOYMENT.md#7-local-docker-deployment)。

## 本地试用

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                       # http://localhost:8787，管理界面在 /manage
```

本地开发没有 Access 保护。要实际生成稿件，还需在 `.dev.vars` 配好转写服务、LLM key 和 GitHub 稿件仓库。示例配置指向本机 `http://127.0.0.1:28100` 的转写服务；正式部署步骤见[部署指南](docs/DEPLOYMENT.md)。如果希望单机运行，可直接走 [Docker 路径](docs/DEPLOYMENT.md#7-local-docker-deployment)。

## 继续阅读

- [部署指南](docs/DEPLOYMENT.md)：初始化、凭据、安全边界、冒烟测试和 Free 限制
- [架构](docs/ARCHITECTURE.md)：任务生命周期、检查点与稿件存储
- [升级指南](docs/UPGRADING.md)：备份和数据库迁移
- [参与开发](.github/CONTRIBUTING.md) · [安全报告](.github/SECURITY.md) · [更新记录](CHANGELOG.md)

早期的 Python/macOS 桌面版代码保存在 [`legacy/python`](https://github.com/xielevi/read-podcast/tree/legacy/python)。v1.0 是支持 Cloudflare 与 Docker 部署的 TypeScript 网页应用。[MIT 许可证](LICENSE)。
