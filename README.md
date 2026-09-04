# Read Podcast · 把播客变成能读的文章

Read Podcast 是一个在你自己电脑上运行的小工具：给它一个播客节目，它会自动**下载音频 → 转成文字 → 用 AI 整理成排版漂亮、可以像杂志文章一样阅读的 Markdown**。全程在网页里点几下就行。

> 适合喜欢“听播客不如读文字”的人。你不需要懂编程，跟着下面的步骤复制粘贴即可。

---

## 🧭 开始前，请先确认三件事

这个工具有三个硬性前提，缺一不可。**先确认你都满足，再往下装**，否则会白忙一场：

1. **你的电脑是 Apple 芯片的 Mac（M1／M2／M3／M4）。**
   一键脚本默认的语音转文字用的是苹果芯片专属的加速能力，Windows、Intel 老款 Mac、Linux 用不了这条默认路径。
   *怎么查：* 点左上角  →「关于本机」，芯片一行写着 “Apple M…” 就对了。
   > 不是 Apple 芯片也别急：本分支新增了**跨平台转录后端**，可改用任意 OpenAI 兼容的
   > 转录服务（云端或自建），在 Windows／Linux／Intel Mac 上也能跑。见下方
   > [「跨平台转录（实验特性）」](#-跨平台转录实验特性)。

2. **你愿意准备一个 AI 服务的 Key。**
   把粗糙的语音稿整理成漂亮文章，需要调用一个 AI 服务，**这一步要花钱**（通常很便宜，几毛到几块钱一篇）。怎么申请见下面 [「申请 AI Key」](#-申请-ai-key)。

3. **联网。** 下载播客、调用 AI 都需要网络。

满足以上三点，就可以开始了。三选一，**推荐第一种**。

---

## 📦 方式一：下载安装包（推荐，不用开终端）

**从 1.0 起**，[Releases 页面](https://github.com/xielevi/read-podcast/releases)
提供已签名并经 Apple 公证的安装包，不需要终端、不需要 Homebrew，也不需要单独装
ffmpeg —— 音频处理组件已经随应用一起分发。

1. 下载 `Read Podcast-<版本>.dmg`。
2. 双击打开，把 **Read Podcast** 拖进 **应用程序**。
3. 从启动台打开它。**不需要**右键→打开，也不需要改任何安全设置。

> 想核对下载是否完整：`shasum -a 256 ~/Downloads/Read\ Podcast-<版本>.dmg`，
> 结果应与 Release 页公布的 SHA256 一致。

**第一次打开会做两件事**，都需要等一会儿：

- 下载语音识别模型，约 **1～2 GB**；
- 需要你填一个 AI 服务的 Key（在网页右上角「设置」里填，见
  [「申请 AI Key」](#-申请-ai-key)）。**精修这一步会按你选的服务商计费**，通常
  几毛到几块钱一篇。

数据存放在 `~/Library/Application Support/Read Podcast/`，卸载、备份和升级见
[「数据、升级与回滚」](#-数据升级与回滚)。

---

## 🚀 方式二：源码一键脚本（想改代码或用开发版）

适合开发者，或者想跟着 `main` 用最新改动的人。需要用终端。

### 第 1 步：下载项目

打开「终端」App（在 启动台 → 其他 里），逐行复制粘贴回车：

```bash
git clone https://github.com/xielevi/read-podcast.git
cd read-podcast
```

> 如果提示没有 `git`，终端会弹窗提示安装，点「安装」等它装完再重来即可。

### 第 2 步：一键安装

```bash
./scripts/install.sh
```

脚本会自动检查电脑型号、安装所需组件（ffmpeg、uv）、下载依赖，并生成配置文件。首次较慢，耐心等它跑完。

### 第 3 步：填入 AI Key

用「文本编辑」打开项目里的 `config/secrets.env` 文件，把你的 Key 粘到 `REFINER_API_KEY=` 后面，保存。（文件不存在就新建一个。）

不想改文件也可以：先跳过这一步直接启动，再在网页右上角点 **设置**，把服务地址、模型和 Key 填进去保存即可（见 [「网页里的设置面板」](#️-网页里的设置面板)）。

（还没有 Key？见 [「申请 AI Key」](#-申请-ai-key)。）

### 第 4 步：启动

```bash
./scripts/start.sh
```

第一次启动会下载语音识别模型（约 1～2 GB），需要等几分钟。就绪后浏览器会自动打开
**<http://127.0.0.1:28000/>** —— 看到网页就可以开始用了。

> 以后每次使用，只要在项目目录里运行 `./scripts/start.sh`。
> 想关闭：回到运行脚本的终端窗口，按 `Control + C`。

### 构建 macOS 安装镜像（维护者）

发布构建需要 Developer ID 证书与公证凭据，完整流程、门禁与发布物清单见
[docs/release.md](docs/release.md)；发布前要跑的验收矩阵见
[docs/release-acceptance.md](docs/release-acceptance.md)。

```bash
bash scripts/pack_macos.sh --dev    # 开发自用：ad-hoc 签名、不公证，不可分发
bash scripts/pack_macos.sh --preview # 未公证预览版：首次启动需右键打开
bash scripts/pack_macos.sh          # 发布：签名 + 公证 + staple，全通过才写 dist/
```

脚本固定独立 Python 与 ffmpeg 资产及其 SHA256，先在临时目录完成 import、签名、
公证和 DMG 完整性验证，全部通过后才替换 `dist/` 产物，并生成 `.dmg.sha256`。
若要把真实语音转写也作为发布门禁：

```bash
READ_PODCAST_PACK_SMOKE_AUDIO=/path/to/short-speech.wav bash scripts/pack_macos.sh
```

---

## 🐳 方式三：Docker

适合已经装了 Docker、或喜欢容器化管理的人。注意：**语音转录仍然要在 Mac 本机跑一个小服务**（它没法放进容器）。所以需要开两个终端窗口。

前提：已安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 或 [OrbStack](https://orbstack.dev/)，并完成方式一的第 1、3 步（下载项目、填好 `.env`）。

**终端窗口 A —— 启动语音转录服务（保持开着）：**

先在 `.env` 中为 `READ_PODCAST_WHISPER_API_TOKEN` 填入一段随机长字符串。Docker
需要跨越宿主机网络访问 MLX，脚本会拒绝在没有 Token 时对外监听。

```bash
./scripts/install.sh        # 若还没装过依赖
./scripts/start-mlx.sh
```

**终端窗口 B —— 启动网页应用：**

```bash
docker compose up -d
```

然后浏览器访问 **<http://127.0.0.1:28000/>**。

- 停止网页应用：`docker compose down`
- 停止语音服务：回到窗口 A 按 `Control + C`

---

## 🔑 申请 AI Key

“精修”这一步需要一个 **OpenAI 兼容** 的 AI 服务。项目**不预设任何服务商**，你需要挑一个、拿到 Key，并把地址和模型名填进配置。下面给出两条常见路线。

**每种服务都要做的两件事：**

1. 把拿到的 Key 填进 `config/secrets.env`：`REFINER_API_KEY=你的key`（用安装包的话，直接在网页「设置」面板里填即可）。
2. 在 `config/config.yaml` 里填服务商的 `refiner.api_base` 和 `refiner.model`（可用选项对照 `modules/config.default.yaml` 的注释，那是只读参考，别直接改它）。

### 路线 A：OpenCode Zen（新手推荐，免费模型无需充值）

1. 打开 <https://opencode.ai/auth> 注册账号（免费模型无需绑卡）。
2. 在控制台创建并复制 API Key，填进 `config/secrets.env`（或网页「设置」面板）。
3. 配置里填：`api_base: https://opencode.ai/zen/v1`，`model` 从其[模型列表](https://opencode.ai/docs/zen/)里挑一个标注免费的填入。
   > 注意：免费模型会不定期更新或下线，若报“模型不存在”，回官网换一个当前可用的免费模型名即可。

### 路线 B：DeepSeek（便宜付费，稳定）

1. 打开 <https://platform.deepseek.com/> 注册账号并充值一点余额（通常几元起）。
2. 在「API Keys」创建并复制以 `sk-` 开头的 Key，填进 `config/secrets.env`（或网页「设置」面板）。
3. 配置里填：`api_base: https://api.deepseek.com/v1`，`model: deepseek-chat`。

其他任何 OpenAI 兼容服务（OpenAI、通义千问等）同理，改这两处即可。

---

## 📖 怎么用

打开网页后：

- 搜索或粘贴播客的 RSS 地址来订阅节目；
- 挑一集，点开始，工具会自动下载 → 转录 → AI 精修；
- 进度和日志会实时显示，完成后即可在「稿件库」里阅读、下载 Markdown。

也可以直接上传一个音频文件来处理。

生成的文章保存在 `workspace/<节目名>/markdown/` 里（安装包版在
`~/Library/Application Support/Read Podcast/workspace/` 下的同名位置）。
想改到别处，在网页「设置 → 文件存放位置」里指定即可。

---

## ⚙️ 网页里的设置面板

不想登录服务器改文件时，点网页右上角的 **设置**，可以直接改这些：

- **AI 精修与助手**：服务商地址（api_base）、模型名称、API Key、温度、最大输出、超时；
- **语音转录**：转录后端（本机 MLX / OpenAI 兼容接口）、服务地址、访问口令、转录模型、语言与上传上限；
- **文件存放位置**：成稿输出目录、音频下载目录。

几点说明：

- **保存后立即生效**，不用重启；下一个任务就会用新配置。
- **密钥不会回显**。页面只显示「已配置 / 未配置」，密钥写入服务器上的 `config/secrets.env`（权限 0600，和 `config.yaml` 同目录，Docker 下随 `config/` 卷持久化）。想换就直接填新的，想删就点「清除」再保存。**这个文件你也可以手动编辑**——面板和手改作用于同一份配置。
- 每组右上角有 **测试连接**，用一次极小的请求验证地址和 Key 是否可用，不会产生真实转录或精修。
- 如果某个字段显示为**灰色只读**，说明它被**部署环境注入的变量**接管了（例如 Docker Compose 里写死的转录地址和输出目录）——这类字段请改 `docker-compose.yml` 或启动脚本。写在 `.env` 里的值**不会**锁定页面，你随时能在网页上覆盖它。
- 留空并保存表示「恢复默认值」。

---

## 💾 数据、升级与回滚

### 你的数据在哪

| 安装方式 | 数据位置 |
| :--- | :--- |
| 安装包（DMG） | `~/Library/Application Support/Read Podcast/`（下含 `config/` 与 `workspace/`） |
| 源码 / Docker | 项目目录下的 `config/` 与 `workspace/` |

订阅、成稿、已读状态、任务记录、API Key 全都在这里，**不在应用本身里**。所以替换
应用不会丢数据，删掉这个目录才会。

源码方式想改数据位置：启动前设 `READ_PODCAST_DATA_DIR=/可写目录`，数据库、上传、
缓存和默认输出会统一改写到该目录。

### 备份

升级前建议先复制一份，这也是回滚时唯一可靠的退路：

```bash
cp -R ~/Library/Application\ Support/Read\ Podcast \
      ~/Desktop/read-podcast-backup-$(date +%Y%m%d)
```

### 升级

- **安装包：** 下载新版 DMG，退出应用，把新的 **Read Podcast** 拖进
  **应用程序** 覆盖旧的。数据目录不动，订阅与稿件原样保留。应用内没有自动更新，
  需要自己回 Releases 页看有没有新版。
- **源码：** `git pull` 后 `./scripts/start.sh`。
- **Docker：** `git pull` 后 `docker compose pull && docker compose up -d`。

### 从源码版迁到安装包

把项目目录里的 `config/` 和 `workspace/` 整个复制到
`~/Library/Application Support/Read Podcast/` 下的同名位置即可。如果你在网页
「设置 → 文件存放位置」里指定过绝对路径，迁移后要回设置面板确认那些路径仍然存在。

### 回滚

1. 退出应用；
2. 把 `/Applications/Read Podcast.app` 换回旧版本（从旧 DMG 重新拖一次）；
3. 数据目录保持不动即可继续用。若新版本改过数据格式导致旧版打不开，就用升级前
   那份备份覆盖回去。

所以**旧版 DMG 请留着**，回滚需要它。

### 彻底卸载

把 `/Applications/Read Podcast.app` 拖进废纸篓，再删掉
`~/Library/Application Support/Read Podcast/`（**这一步会连同订阅和全部成稿一起
删除，删之前先确认已经备份**）。

---

## 🗂️ 配置在哪里改

**只有一个地方 —— `config/` 目录，两个文件：**

| 文件 | 放什么 |
| :--- | :--- |
| `config/config.yaml` | 普通设置：AI 地址与模型、转录后端、输出目录、订阅 |
| `config/secrets.env` | 密钥：API Key、访问口令（权限 0600） |

**手动编辑和网页「设置」面板作用于同一份配置**，改哪边都行。两个文件都不进版本库，`git pull` 不会覆盖。

> `modules/config.default.yaml` 是**内置默认值，不要改**（改了 `git pull` 会冲突）。
> 它的作用是**参考手册**：想知道有哪些可用选项，读它的注释，然后把要改的项抄到 `config/config.yaml`。
>
> 完整说明见 [config/README.md](config/README.md)。

其余目录：

- `workspace/`：下载的音频、转录缓存、日志、任务记录，以及成稿
  （`workspace/<节目名>/markdown/`）。
- `.env`：旧版密钥位置，仍可用；建议搬到 `config/secrets.env` 统一到一处。

默认工作数据仍写入仓库 `workspace/`。打包应用或其他只读代码目录可在启动前设置
`READ_PODCAST_DATA_DIR=/可写目录`，数据库、上传、缓存和默认输出会统一改写到该目录。

这些内容都保存在你自己的电脑上，不会被提交到 Git。处理过程中仍会发生以下联网传输：

- 搜索词发送到 Apple iTunes 搜索接口；RSS 和音频请求发送到对应播客托管方；
- 你选择精修时，完整原始转录和 Prompt 会发送给自己配置的 AI 服务商；
- 音频、转录缓存、日志和成稿会按本地配置保留，文件本身不加密。

---

## ❓ 常见问题

- **安装脚本说“只支持 Apple 芯片的 Mac”。** 很遗憾，本工具的语音转录依赖苹果芯片，其他设备暂时无法使用。
- **网页能打开，但一处理就报错、提示转录失败。** 多半是语音服务没启动。用方式一的话，`start.sh` 会自动带起它；用 Docker 的话，请确认窗口 A 的 `start-mlx.sh` 还开着。
- **精修（AI 整理）那一步失败。** 检查 `config/secrets.env` 里的 `REFINER_API_KEY` 是否填对、账户是否有余额、`config/config.yaml` 里的服务商地址是否正确。
- **第一次特别慢。** 首次会下载 1～2 GB 的语音模型，属正常，之后就快了。

---

## 🔒 隐私与安全

- 一键原生模式默认只监听 `127.0.0.1`。Docker 模式的 MLX 辅助脚本会监听宿主机网络，但强制要求 Token。
- 语音服务端口 `21567` 不要暴露到公网；跨设备访问时还应配置防火墙或可信网络。
- 如需从外网访问网页，应同时启用 HTTPS 和 Basic Auth（在 `config/secrets.env` 里填写用户名与密码），或使用 Tailscale／受控反向代理。Basic Auth 本身不加密传输。
- 默认拒绝指向回环、内网和链路本地地址的 RSS/媒体 URL，防止服务器被用来访问本机服务。
- 不要把 `.env`、真实订阅、音频、转录稿或数据库提交到 Git。

请只下载、转录和分享你有权处理的节目或录音。项目的 MIT 许可证只适用于软件代码，
不会授予任何播客音频、节目文字或第三方内容的使用权。

---

## 🧪 实验特性（本分支）

> 以下为实验分支新增能力，用来降低平台依赖、补齐“读完还能用起来”的环节。默认配置不变，需要时再开启。

### 🌍 跨平台转录（实验特性）

不想被“只能 Apple 芯片”限制时，有两条实验路径。Mac mini 自用仍推荐默认 MLX，
速度和能效都明显优于 Docker CPU 转录。

#### 方案 A：仓库内置转录服务（自包含）

适合 Linux、Windows + Docker Desktop、Intel Mac，也可在 Apple Silicon Docker 中以 CPU 运行。
它会从当前实验分支构建 Web 应用和独立 Faster-Whisper 服务：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.self-contained.yml up -d --build
```

默认模型是 `small`，首次转录时下载到持久化 volume；后续重建容器不会重复下载。
需要其他模型时，在执行 Compose 前设置环境变量
`READ_PODCAST_BUILTIN_WHISPER_MODEL=large-v3-turbo`。模型越大，
首次下载、内存和 CPU 转录时间也越大。转录服务不暴露宿主端口，只在 Compose 内部网络可见。

#### 方案 B：外部 OpenAI 兼容转录 API

可把转录换成任意 **OpenAI 兼容** 的 `/audio/transcriptions` 服务。
在 `config/config.yaml` 里：

```yaml
transcription:
  backend: openai-api
  openai:
    api_base: https://api.groq.com/openai/v1   # 或 OpenAI、自建 faster-whisper-server
    model: whisper-large-v3                     # OpenAI 用 whisper-1；自建用其模型名
    language: ""                                # 留空自动检测；可填 zh、en
    max_upload_bytes: 0                          # 0 不限制；云端一般限制 25MB（26214400）
```

并在 `config/secrets.env` 里填 `READ_PODCAST_TRANSCRIPTION_API_KEY=你的key`。这样在
Windows／Linux／Intel Mac 上也能转录。云端接口通常限制单文件 25MB，处理一两个小时的长节目
建议改用方案 A 或指向你自建的服务。默认 `backend: mlx-api` 行为不变。

### 🤖 AI 阅读助手（百科查询 + 文字稿问答）

阅读稿件时，右上角的「AI 助手」可以：

- **文字稿问答**：基于当前这篇稿子提问（“这期核心观点是什么？”“嘉宾举了哪些案例？”），
  回答严格来自文字稿，稿中没有会如实说明。
- **划词百科查询**：在正文里选中一个概念/人物/术语，点浮现的「解释」即可看到通俗解释。
- **跨节目提问**：在「稿件库」顶部的提问框里，从最近最多 60 期稿件中检索后综合作答，例如
  “最近几期主要讲了什么”“大家如何评价 AI Agent”“不同嘉宾有哪些共识和分歧”。
  回答会标注来源节目，点一下即可跳到对应稿件。检索为零依赖的关键词匹配，无需向量库。

它复用你已经配置好的精修服务商（`refiner.api_base` / `refiner.model` 与 `REFINER_API_KEY`），
无需另配 Key。没配置 AI 时，助手入口会自动隐藏，不影响转录主流程。

### 📚 关键概念 → 维基百科

打开一篇稿子会自动为它抽取 5–10 个值得延伸阅读的概念（人物、机构、术语、事件、作品），
每个都带**真实的维基百科链接**和一句话摘要。左侧栏「关键概念」列出完整清单，正文里每个
概念第一次出现的地方也会原地变成可点的维基百科链接，不用来回切换到侧栏找。

链接不是 AI 编的：AI 只负责从文字稿里**提名**候选词，每个词都会到维基百科实际核对——
先按词条名直查（自动跟随重定向，「斯坦福大学」会正确指向「史丹佛大學」），查不到再退到搜索，
且搜索结果必须与原词足够接近才采用。核对不到词条的候选**直接丢弃**，所以实际条数可能少于
上限。这是有意的取舍：一个指向错误词条的链接，比没有链接更糟。

中文站查不到的词会自动退到英文维基百科。可在 `config/config.yaml` 调整：

```yaml
runtime:
  wikipedia:
    lang: zh              # 主语言站点
    fallback_lang: en     # 主语言查不到时回退（留空则不回退）
    limit: 8              # 目标条数，5–10
```

抽取要过一次 AI，所以默认由你点按钮触发，不会在每次打开稿件时自动消耗额度；
同一篇稿子的结果会被缓存，正文没变就直接复用。

### 🗂️ 杂志封面合集

订阅节目时会自动记住它的封面图（搜索添加用 iTunes 封面，直接填 RSS 则用频道封面）。
「播客订阅」页顶部会把这些封面拼成一条杂志式合集封面，点封面即可跳到对应节目。
封面图统一经服务端代理加载（做了 SSRF 校验与体积/类型限制），浏览器不会直连第三方 CDN。

### 📤 文件连接器（发送到飞书 / 钉钉 / Notion / 自建知识库）

读完一篇稿件，在阅读页点「发送到…」，把成稿推送到你配置的外部目标。每个目标都能选
**整篇** 或 **知识摘要**（AI 先提炼核心观点/案例/知识点/延伸选题再发送，实现「把播客沉淀成知识库」），
还能点 **测试** 预检凭据。支持两类目标：

- **群机器人 Webhook**（短消息）：飞书 / 钉钉 / Slack / 通用 JSON Webhook。
- **云文档知识库**（真正的文档）：`notion`（在数据库或页面下新建页面）、`feishu-doc`（新建一篇飞书 Docx）、
  `gdrive`（在 Google Drive 新建一篇 Google 文档，或存成 `.md` 文件）。

Google 文档与飞书文档也可以直接从 WebUI 左下角登录。首次连接会要求填写开发者应用的
Client/App ID 与 Secret，然后跳转到对应账号授权；刷新令牌只保存在本机
`config/secrets.env`。两边开发者后台都必须把当前站点的回调地址加入允许列表：

```text
https://你的站点[/子路径]/api/read-podcast/integrations/google/callback
https://你的站点[/子路径]/api/read-podcast/integrations/feishu/callback
```

Google 应用需启用 Drive API 并允许 `drive.file`；飞书应用需开通创建、编辑云文档所需权限。
原有手工 `connectors` 配置仍然兼容，并且优先于内置 OAuth 连接器。

在 `config/config.yaml` 里声明连接器，凭据只填在 `config/secrets.env`：

```yaml
connectors:
  - name: 飞书群
    format: feishu                 # feishu | dingtalk | slack | markdown
    url_env: READ_PODCAST_CONNECTOR_FEISHU_URL
  - name: Notion 知识库
    format: notion                 # 在 Notion 数据库里，每期存成一页
    token_env: READ_PODCAST_CONNECTOR_NOTION_TOKEN
    database_id: 你的数据库ID
  - name: 飞书文档
    format: feishu-doc             # 新建一篇飞书 Docx 文档
    app_id_env: READ_PODCAST_CONNECTOR_FEISHU_APP_ID
    app_secret_env: READ_PODCAST_CONNECTOR_FEISHU_APP_SECRET
  - name: Google Drive
    format: gdrive                 # 新建一篇 Google 文档
    client_id_env: READ_PODCAST_CONNECTOR_GDRIVE_CLIENT_ID
    client_secret_env: READ_PODCAST_CONNECTOR_GDRIVE_CLIENT_SECRET
    refresh_token_env: READ_PODCAST_CONNECTOR_GDRIVE_REFRESH_TOKEN
    # folder_id: 你的文件夹ID       # 可选，留空存到「我的云端硬盘」根目录
    # doc_format: gdoc             # gdoc（默认，可直接编辑）或 markdown（存 .md）
```

凭据（Webhook 地址 / Notion token / 飞书 App Secret / Google 刷新令牌，均属机密）只填在 `config/secrets.env`
的对应变量里，代码不硬编码任何服务商；`/connectors` 接口也绝不回传地址或凭据。没配置连接器时，
「发送到…」入口会自动隐藏。

<details>
<summary>Google Drive 怎么拿到那三个值</summary>

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 新建项目，启用 **Google Drive API**。
2. 「OAuth 同意屏幕」选 **外部**，把自己的账号加进「测试用户」。
3. 「凭据 → 创建凭据 → OAuth 客户端 ID」，类型选 **桌面应用**，得到 `client_id` 与 `client_secret`。
4. 用这两个值走一次 OAuth 授权（作用域 `https://www.googleapis.com/auth/drive.file`，
   即只能访问本应用自己创建的文件），换到 `refresh_token`。可用
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)，在设置里勾选
   「Use your own OAuth credentials」填入上面两个值。
5. 三个值分别填进 `config/secrets.env` 的 `READ_PODCAST_CONNECTOR_GDRIVE_*`，回页面点「测试」验证。

用刷新令牌而不是服务账号，是因为个人 Google 账号下服务账号没有独立存储配额，
上传会失败，且文件不归属你本人。

</details>

## 🛠️ 进阶与开发

- 架构与设计决策：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 网页 API：[docs/web-api.md](docs/web-api.md) · 模块说明：[docs/modules.md](docs/modules.md)
- 协作边界：[AGENTS.md](AGENTS.md) · 参与贡献：[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)
- 反向代理子路径、Basic Auth、分离部署（网页应用与语音服务分处两台机器）等高级用法，见上述架构文档。

镜像发布：`main` 分支测试通过后由 GitHub Actions 自动发布多架构镜像到
`ghcr.io/xielevi/read-podcast:latest`。

---

## 📄 许可证

[MIT](LICENSE)
