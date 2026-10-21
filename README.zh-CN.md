# Read Podcast

[English](README.md) · **简体中文**

**没时间重听的播客，换成读的。** Read Podcast 把你选中的单集整理成一份三分钟导读和一篇完整对谈长稿——像杂志编辑访谈稿那样，标出说话人、分好章节、保留时间戳——每一篇都以 Markdown 存进你自己掌控的地方。

[![CI](https://github.com/xielevi/read-podcast/actions/workflows/ci.yml/badge.svg)](https://github.com/xielevi/read-podcast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/xielevi/read-podcast)](LICENSE)
[![Runs on Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](docs/DEPLOYMENT.md#2-cloudflare-application)
[![Self-host with Docker Compose](https://img.shields.io/badge/self--host-Docker%20Compose-2496ED?logo=docker&logoColor=white)](docs/DEPLOYMENT.md#7-local-docker-deployment)

**[在线体验 → read-podcast.xielevi.cc](https://read-podcast.xielevi.cc)** · [工作方式](#工作方式) · [快速开始](#快速开始) · [横向对比](#横向对比)

<p align="center">
  <img src="docs/assets/readme/flow.gif" alt="从节目列表打开一集：先看三分钟导读，再看小节摘要和全文" width="920">
</p>

## 为什么需要它

一期两小时的对谈，每一分钟都值得。可一周后你想找回那个最打动你的论证，唯一的办法是拖着进度条重听。节目简介只列了话题，AI 摘要把两小时压成几条要点——结论还在，推理和例子都没了。

Read Podcast 留下的是对话本身。它转写你选中的单集，再像杂志编辑访谈稿那样整理：删掉口语重复，留下论证、证据和你来我往。最后得到一篇三分钟就能扫完要点、也能通读全文，能搜、能引用、能长期保存的文章。

## 适合谁

- **长访谈节目的重度听众**——商业、科学、历史、科技——想回到某个论证，又不想重听。
- **研究者、写作者和学生**——需要引用播客，需要准确、可署名的文字。
- **做笔记的人**——维护着 Markdown 笔记库（Obsidian、Git 仓库），希望单集以真正的文档形式进入其中。
- **自托管用户**——宁愿用自己的部署和自己的模型密钥，也不想再多一份订阅。

这是面向个人或小范围私有部署的单人工作区，不是多用户服务。

## 工作方式

1. **订阅**：在 Apple Podcasts 中搜索，或粘贴任意 RSS 地址；也可以上传自己的音频。
2. **转写**：选一期，点「生成稿件」。转写跑在你自己的 Whisper 服务上（Apple Silicon 上的 MLX、Docker 内的 Faster-Whisper），也可以用云端服务。
3. **整理**：任意 OpenAI 兼容的 LLM 把转写稿整理成长稿，编辑指令按单集的语言选择：中文节目用中文指令、产出中文稿件，英文节目用英文指令、产出自然的英文稿件。
4. **阅读**：先看三分钟导读，扫一遍每个小节下的一句话摘要，再在为长文设计的阅读器里读全文，电脑和手机都行。每篇稿件同时也是一份归你所有的 Markdown 文件。

## 整理前后对比

<p align="center">
  <img src="docs/assets/readme/before-after.webp" alt="示意的语音识别原文与同一段落的整理稿对比" width="920">
</p>

语音识别直接给你的是这样的 *（示意——为本文编写的典型未经整理的 ASR 输出）*：

```text
嗯对 说到这个航天飞机这个项目啊 首先就是 首先需要回溯到它的前身 就是那个阿波罗
然后呃几个月之前我看了一个那个采访 他提了一个 很有意思的视角 就是所有我们认为的
这个工程学上的超级项目 要想成功的话几乎都 都依赖三个 三项先决条件 第一个是稳定的
政治承诺 第二个就是呃 有保障的资金支持 第三就是清晰的 阶段性的目标
```

Read Podcast 发布的是这样的 *（[在线体验](https://read-podcast.xielevi.cc/a/26b88d3a-3b60-430d-b709-7d36ed52e741)中的真实片段，忽左忽右 #502）*：

```markdown
## 02 | 超级工程的三大先决条件

**刘怡**：说到航天飞机这个项目，首先需要回溯到它的前身，就是大家应该都知道的美国载人登月的阿波罗计划。……
他提了一个很有意思的视角：所有我们所认为的工程学上的超级项目，要想成功几乎都依赖三项先决条件——
第一，稳定的政治承诺；第二，有保障的资金支持；第三，清晰的阶段性目标。
```

*上面的成稿片段保留原文，未作改写。README 截图使用英文界面和一期为演示虚构的英文对谈，内容与此处中文片段不同。*

这期 63 分钟的节目，最终成稿约 1.7 万字：开头是带时间戳的大纲，正文分六个小节，两位说话人都标出了真名。篇幅有硬性检查：默认情况下，成稿不足转写稿 70% 长度就过不了质量门禁，不会发布。在线体验里都是中文节目；英文节目会使用英文编辑指令整理，导读和小节摘要也是英文。

## 先读导读，想看再读全文

每篇稿件开头是一份三分钟导读：核心结论、要点、原话金句，以及适合谁读全文。每个小节开头有一句摘要，可以先扫一遍结构，再挑重要的部分细读。手机上也是同样的读法。

<p align="center">
  <img src="docs/assets/readme/reader-brief.webp" alt="阅读器：正文上方的三分钟导读" width="920">
</p>

<p align="center">
  <img src="docs/assets/readme/mobile.webp" alt="手机阅读：导读卡，以及带一句话摘要的小节标题" width="720">
</p>

## 示例稿件

在线体验是维护者自己的实例，对访客只读开放（想生成新稿件，请部署你自己的一份）。在线稿件库是中文节目，可以用 **中 / EN** 按钮切换界面语言。可以先读几篇完整成稿：

- [宇宙超级工程是如何垮掉的：刘怡谈「挑战者号」事故四十周年](https://read-podcast.xielevi.cc/a/26b88d3a-3b60-430d-b709-7d36ed52e741) — 忽左忽右 · 63 分钟 · 两位说话人，6 个小节
- [袁长庚×胡安焉：脏活与狗屁工作，谁在工位追问意义？](https://read-podcast.xielevi.cc/a/8c2652d0-99b6-4985-9c65-9e5ba766b7e6) — 上海书评 · 80 分钟 · 三位说话人，11 个小节
- [对话经济学家朱宁：1929之后，我们学会避免下一场经济危机了吗？](https://read-podcast.xielevi.cc/a/6a85212f-236c-577d-a554-a8375452e068) — 知行小酒馆 · 73 分钟 · 两位说话人，12 个小节

<p align="center">
  <img src="docs/assets/readme/library.webp" alt="Read Podcast 的订阅与稿件工作区" width="920">
</p>

*截图来自一个本地实例，订阅的是公开的英文播客 RSS（节目名、封面和单集标题都取自各自的 RSS）。截图里可阅读的稿件是占位内容，主打的那期节目是虚构的，没有转载任何真实转写稿。*

## 功能

- **订阅或导入**：在 Apple Podcasts 中搜索节目、粘贴任意 RSS 地址，或上传自己的音频（最多 200 MiB）。
- **处理哪一集由你决定**：逐集手动开始生成，新单集不会自动处理。关掉浏览器，任务照样继续。
- **整理成长稿，而不是摘要**：标注说话人（简介里有名字就用真名）、分章节、生成带时间戳的大纲；删掉重复，保留论证和例子。你填写的自定义指令优先。
- **先读三分钟导读**：每篇新稿件会尽力生成一份导读（一句话结论、要点、原话金句、适合谁读、阅读时长），并在每个小节标题下附一句摘要，读完再决定要不要看全文。
- **为长文设计的阅读器**：目录导航、排版设置，关键概念按阅读界面语言链接到维基百科。
- **中英双语**：界面默认跟随浏览器语言，手动切换后会记住；整理、导读和小节摘要的指令跟随单集的语言，英文节目产出英文稿件。
- **Markdown 归你所有**：每篇稿件都是带 YAML front matter 的 Markdown 文件，Cloudflare 部署存进你的 GitHub 仓库，Docker 部署存进本地目录，可直接放进 Obsidian。阅读器里也能下载任意一篇。
- **公开只读浏览**：访客在 `/` 可以浏览订阅和已发布稿件；所有会改变状态的操作都在 `/manage` 之下。
- **可分享、可订阅**：每篇稿件都有带链接预览的永久链接 `/a/<id>`；`/feed.xml` 是附带导读的 Atom 订阅源，任意 RSS 阅读器都能订阅新稿件。
- **自托管，模型自选**：部署在 Cloudflare Workers 或单台 Docker 主机；转写可用本地 Whisper（Apple Silicon 上的 MLX、Docker 内的 Faster-Whisper）、OpenAI 兼容的上传代理或百炼 DashScope；整理可用任意 OpenAI 兼容的 LLM API。

## 横向对比

按产品类别比较，具体产品各有差异。

| | 播客 App 内置 AI 摘要 | 转写服务 | 划线 / 笔记类 App | **Read Podcast** |
|---|---|---|---|---|
| 得到什么 | 简短回顾或章节要点 | 逐字转写稿 | 你标记片段的剪辑与笔记 | 经过整理的完整长稿 |
| 对论证的保留 | 只有结论，推理很少 | 全部保留，连同口头禅和说错重来 | 只有你划过的部分 | 保留推理和例子；默认不少于转写稿 70% 篇幅 |
| 文字存在哪里 | App 内部 | 你导出的文件 | App 内，可导出 | 你的 GitHub 仓库或本地目录里的 Markdown |
| 能否自托管 | 不能 | 通常只有托管服务 | 一般不能 | 可以——Cloudflare 或 Docker，MIT 许可 |
| 费用模式 | 随 App 或其订阅附带 | 按分钟或订阅计费 | 免费增值或订阅 | 自己的托管费用加 LLM 用量；本地转写不产生 API 费用 |
| 上手成本 | 无 | 无 | 无 | 需要自己部署，并准备 LLM API key |

## 快速开始

### Docker：最快的路径

需要 Docker 和任意 OpenAI 兼容 LLM 的 API key。转写在自带的 Faster-Whisper 容器里本地运行，成稿保存在 `./manuscripts`。

```bash
git clone https://github.com/xielevi/read-podcast.git && cd read-podcast
cp .env.example .env              # 填入 REFINER_API_KEY
docker compose up -d
```

打开 `http://127.0.0.1:3000/manage`，在 **设置 → 高级设置** 中填写服务商的 API 地址和模型。端口只绑定本机；如需对外开放，请先设置 `CONTROL_AUTH_USER` / `CONTROL_AUTH_PASSWORD`。详见 [Docker 路径](docs/DEPLOYMENT.md#7-local-docker-deployment)。

### Cloudflare：部署在边缘的阅读站

运行在 Workers、D1、Workflows 和 R2 上，稿件发布到你自己的 GitHub 仓库。需要一个托管在 Cloudflare 的域名、一个转写后端（通过 Tunnel 接入的自建[转写服务](docs/DEPLOYMENT.md#3-transcription-service)，或[百炼 DashScope](docs/DEPLOYMENT.md#4-cloud-transcription-dashscope-paraformer)），以及 LLM API key。

```bash
npm install
npm run setup                     # 幂等：创建 D1/R2、交互录入密钥、打印 Access 配置清单
```

然后按 [Cloudflare 部署指南](docs/DEPLOYMENT.md#2-cloudflare-application)完成 Access、Tunnel 和部署。一键 **Deploy to Cloudflare** 模板正在评审中，须在全新账号完成部署验证后才会把按钮放到这里（[剩余检查项](docs/DEPLOYMENT.md#deploy-to-cloudflare-template-one-click-deployment)）。

维护者在 Workers Free 上运行 Cloudflare 版，但这不能证明所有工作负载都有充足的 CPU、子请求或 Workflow 余量。请按自己的用量核对 [Free 计划限制](docs/DEPLOYMENT.md#resource-names-and-free-plan-boundary-checks)；LLM 和云端转写可能另行计费。

### 安全边界

这是单主人工作区。`/` 默认公开；如果订阅和稿件也要保密，请保护整个域名。在 Cloudflare 上，`/manage*` 和 `/api/control/*` **必须**受保护：自定义域名用 Cloudflare Access，workers.dev 用 Basic Auth；workers.dev 上未配置 Basic Auth 凭据时，控制面会拒绝所有请求。Docker 默认只绑定本机，可选启用 Basic Auth。详见[部署指南](docs/DEPLOYMENT.md)和[安全策略](.github/SECURITY.md)。

## 路线图

开发中，尚未发布：

- **Deploy to Cloudflare 按钮**：等待全新账号验证。

## 文档

- [部署指南](docs/DEPLOYMENT.md)：初始化、凭据、安全边界、冒烟测试和 Free 限制
- [架构](docs/ARCHITECTURE.md)：任务生命周期、检查点与稿件存储
- [升级指南](docs/UPGRADING.md)：备份和数据库迁移
- [更新记录](CHANGELOG.md)

## 参与贡献

欢迎提 issue 和 PR。请先阅读[贡献指南](.github/CONTRIBUTING.md)，安全问题请按[安全策略](.github/SECURITY.md)报告。在本地开发 Worker：

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                       # http://localhost:8787，管理界面在 /manage
```

本地开发没有 Access 保护。要实际生成稿件，还需在 `.dev.vars` 配好转写服务、LLM key 和 GitHub 稿件仓库；示例配置指向本机 `http://127.0.0.1:28100` 的转写服务。

如果 Read Podcast 帮你省下了一次重听，**在 GitHub 上点个 ⭐**，能让更多人发现它。

早期的 Python/macOS 桌面版代码保存在 [`legacy/python`](https://github.com/xielevi/read-podcast/tree/legacy/python)；v1.0 是支持 Cloudflare 与 Docker 部署的 TypeScript 网页应用。[MIT 许可证](LICENSE)。
