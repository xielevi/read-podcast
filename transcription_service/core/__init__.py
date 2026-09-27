"""Transcription Service 的核心模块。

- ``config``           内建运行时默认值与平台数据 / 日志路径（没有配置文件、没有 secret）；
- ``downloader``       音频源获取（逐跳 SSRF 校验的直链抓取），带体积上限；
- ``network_security`` 出站 HTTP 安全助手（只允许公网地址，逐跳复核重定向）；
- ``transcriber``      转录引擎适配（本机 MLX Whisper），失败以稳定 ``code`` 抛出；
- ``naming``           文件系统安全的命名 helper。

本服务只做计算：不持有任何 LLM 凭据，也不认识 Cloudflare 的业务概念（任务、attempt、重试、精修、成稿）。
"""
