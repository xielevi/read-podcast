# 第三方组件许可证声明

Read Podcast 本体以 MIT 许可证发布（见 [LICENSE](LICENSE)）。macOS 分发的
`Read Podcast.app` 里还随包带有下列**第三方组件**，它们各自适用自己的许可证。

本文件是发布物的一部分：`scripts/pack_macos.sh --check` 会检查它存在，
发布构建会把它复制进 `Read Podcast.app/Contents/Resources/`。

## 随包分发的独立组件

| 组件 | 用途 | 许可证 | 来源 |
|---|---|---|---|
| CPython（python-build-standalone 构建） | App 内置的 Python 运行时 | Python Software Foundation License；构建产物中另含 OpenSSL 等组件的许可证 | https://github.com/astral-sh/python-build-standalone |
| FFmpeg（`ffmpeg`、`ffprobe`） | 音频解码与切片 | **LGPL-2.1-or-later**（本项目只分发不带 `--enable-gpl` 的 LGPL 构建） | https://ffmpeg.org/ |

具体固定的版本号、下载地址与 SHA256 记录在 `scripts/pack_macos.sh`
（Python 运行时）和 `scripts/ffmpeg-asset.env`（FFmpeg 官方源码）里。FFmpeg 使用
`--disable-autodetect --disable-shared --enable-static` 构建，不传
`--enable-gpl` 或 `--enable-nonfree`；版本与配置也写在每次 Release Notes 中。

### 关于 FFmpeg 与 LGPL

App 不静态链接 FFmpeg，而是把 `ffmpeg` / `ffprobe` 作为**独立可执行文件**放进
bundle，运行时通过子进程调用。使用者可以用自己的同名构建替换
`Read Podcast.app/Contents/Resources/bin/` 下的这两个文件。

FFmpeg 对应版本的完整源码可从上游获取：https://ffmpeg.org/download.html
（也可向本项目 Issues 索取所分发构建对应的源码 tarball 与 configure 参数）。

## Python 依赖

App 内置的依赖按 `uv.lock` 精确安装，主要包括 feedparser、PyYAML、requests、
yt-dlp、python-dotenv、FastAPI、uvicorn、httpx、aiosqlite、python-multipart、
socksio，以及可选的 mlx-whisper（及其带入的 numpy）。

这些包各自的许可证以其发行元数据为准，不在此处逐条复述。要生成当前锁定版本的
完整逐包清单：

```bash
uv export --format requirements-txt --no-hashes | \
  cut -d= -f1 | xargs -I{} uv run python -c \
  "import importlib.metadata as m,sys;d=m.metadata('{}');print('{}', d.get('License-Expression') or d.get('License') or 'see package metadata')"
```

## 模型权重

语音转录使用的 Whisper 模型权重在**首次运行时由用户自己下载**，不随 App 分发，
适用其在 Hugging Face 上各自声明的许可证。
