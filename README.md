# Podcast2MD · 把播客变成能读的文章

Podcast2MD 是一个在你自己电脑上运行的小工具：给它一个播客节目，它会自动**下载音频 → 转成文字 → 用 AI 整理成排版漂亮、可以像杂志文章一样阅读的 Markdown**。全程在网页里点几下就行。

> 适合喜欢“听播客不如读文字”的人。你不需要懂编程，跟着下面的步骤复制粘贴即可。

---

## 🧭 开始前，请先确认三件事

这个工具有三个硬性前提，缺一不可。**先确认你都满足，再往下装**，否则会白忙一场：

1. **你的电脑是 Apple 芯片的 Mac（M1／M2／M3／M4）。**
   语音转文字用的是苹果芯片专属的加速能力，Windows、Intel 老款 Mac、Linux 都用不了。
   *怎么查：* 点左上角  →「关于本机」，芯片一行写着 “Apple M…” 就对了。

2. **你愿意准备一个 AI 服务的 Key。**
   把粗糙的语音稿整理成漂亮文章，需要调用一个 AI 服务，**这一步要花钱**（通常很便宜，几毛到几块钱一篇）。怎么申请见下面 [「申请 AI Key」](#-申请-ai-key)。

3. **联网。** 下载播客、调用 AI 都需要网络。

满足以上三点，就可以开始了。二选一，**推荐第一种**。

---

## 🚀 方式一：一键脚本（推荐，最简单）

适合个人在自己的 Mac 上使用。一条命令搞定，不需要安装 Docker。

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

用「文本编辑」打开项目里的 `.env` 文件，把你的 Key 粘到 `REFINER_API_KEY=` 后面，保存。

（还没有 Key？见 [「申请 AI Key」](#-申请-ai-key)。）

### 第 4 步：启动

```bash
./scripts/start.sh
```

第一次启动会下载语音识别模型（约 1～2 GB），需要等几分钟。就绪后浏览器会自动打开
**<http://127.0.0.1:28000/>** —— 看到网页就可以开始用了。

> 以后每次使用，只要在项目目录里运行 `./scripts/start.sh`。
> 想关闭：回到运行脚本的终端窗口，按 `Control + C`。

---

## 🐳 方式二：Docker

适合已经装了 Docker、或喜欢容器化管理的人。注意：**语音转录仍然要在 Mac 本机跑一个小服务**（它没法放进容器）。所以需要开两个终端窗口。

前提：已安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 或 [OrbStack](https://orbstack.dev/)，并完成方式一的第 1、3 步（下载项目、填好 `.env`）。

**终端窗口 A —— 启动语音转录服务（保持开着）：**

先在 `.env` 中为 `PODCAST2MD_WHISPER_API_TOKEN` 填入一段随机长字符串。Docker
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

1. 把拿到的 Key 填进项目的 `.env`：`REFINER_API_KEY=你的key`。
2. 在 `config/config.yaml` 里填服务商的 `refiner.api_base` 和 `refiner.model`（对照 `config.default.yaml` 顶部注释里的示例）。

### 路线 A：OpenCode Zen（新手推荐，免费模型无需充值）

1. 打开 <https://opencode.ai/auth> 注册账号（免费模型无需绑卡）。
2. 在控制台创建并复制 API Key，填进 `.env`。
3. 配置里填：`api_base: https://opencode.ai/zen/v1`，`model` 从其[模型列表](https://opencode.ai/docs/zen/)里挑一个标注免费的填入。
   > 注意：免费模型会不定期更新或下线，若报“模型不存在”，回官网换一个当前可用的免费模型名即可。

### 路线 B：DeepSeek（便宜付费，稳定）

1. 打开 <https://platform.deepseek.com/> 注册账号并充值一点余额（通常几元起）。
2. 在「API Keys」创建并复制以 `sk-` 开头的 Key，填进 `.env`。
3. 配置里填：`api_base: https://api.deepseek.com/v1`，`model: deepseek-chat`。

其他任何 OpenAI 兼容服务（OpenAI、通义千问等）同理，改这两处即可。

---

## 📖 怎么用

打开网页后：

- 搜索或粘贴播客的 RSS 地址来订阅节目；
- 挑一集，点开始，工具会自动下载 → 转录 → AI 精修；
- 进度和日志会实时显示，完成后即可在「稿件库」里阅读、下载 Markdown。

也可以直接上传一个音频文件来处理。

生成的文章保存在项目的 `output/` 目录里。

---

## 🔄 更新到新版本

**一键脚本方式：**

```bash
git pull
./scripts/start.sh
```

**Docker 方式：** `git pull` 后 `docker compose pull && docker compose up -d`。

---

## 🗂️ 你的数据在哪里

- `config/`：你的设置和订阅（首次自动生成，可编辑）。
- `workspace/`：下载的音频、转录缓存、日志、任务记录。
- `output/`：最终生成的 Markdown 文章。
- `.env`：你的密钥。

这些内容都保存在你自己的电脑上，不会被提交到 Git。处理过程中仍会发生以下联网传输：

- 搜索词发送到 Apple iTunes 搜索接口；RSS 和音频请求发送到对应播客托管方；
- 你选择精修时，完整原始转录和 Prompt 会发送给自己配置的 AI 服务商；
- 音频、转录缓存、日志和成稿会按本地配置保留，文件本身不加密。

---

## ❓ 常见问题

- **安装脚本说“只支持 Apple 芯片的 Mac”。** 很遗憾，本工具的语音转录依赖苹果芯片，其他设备暂时无法使用。
- **网页能打开，但一处理就报错、提示转录失败。** 多半是语音服务没启动。用方式一的话，`start.sh` 会自动带起它；用 Docker 的话，请确认窗口 A 的 `start-mlx.sh` 还开着。
- **精修（AI 整理）那一步失败。** 检查 `.env` 里的 `REFINER_API_KEY` 是否填对、账户是否有余额、`config.default.yaml` 里的服务商地址是否正确。
- **第一次特别慢。** 首次会下载 1～2 GB 的语音模型，属正常，之后就快了。

---

## 🔒 隐私与安全

- 一键原生模式默认只监听 `127.0.0.1`。Docker 模式的 MLX 辅助脚本会监听宿主机网络，但强制要求 Token。
- 语音服务端口 `21567` 不要暴露到公网；跨设备访问时还应配置防火墙或可信网络。
- 如需从外网访问网页，应同时启用 HTTPS 和 Basic Auth（在 `.env` 里填写用户名与密码），或使用 Tailscale／受控反向代理。Basic Auth 本身不加密传输。
- 默认拒绝指向回环、内网和链路本地地址的 RSS/媒体 URL，防止服务器被用来访问本机服务。
- 不要把 `.env`、真实订阅、音频、转录稿或数据库提交到 Git。

请只下载、转录和分享你有权处理的节目或录音。项目的 MIT 许可证只适用于软件代码，
不会授予任何播客音频、节目文字或第三方内容的使用权。

---

## 🛠️ 进阶与开发

- 架构与设计决策：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 网页 API：[docs/web-api.md](docs/web-api.md) · 模块说明：[docs/modules.md](docs/modules.md)
- 协作边界：[AGENTS.md](AGENTS.md) · 参与贡献：[CONTRIBUTING.md](CONTRIBUTING.md)
- 反向代理子路径、Basic Auth、分离部署（网页应用与语音服务分处两台机器）等高级用法，见上述架构文档。

镜像发布：`main` 分支测试通过后由 GitHub Actions 自动发布多架构镜像到
`ghcr.io/xielevi/read-podcast:latest`。

---

## 📄 许可证

[MIT](LICENSE)
