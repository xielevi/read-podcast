# Read Podcast Transcription Service —— Linux / NAS / 服务器部署的转录计算容器。
#
# 引擎是进程内 Faster-Whisper（CPU / CUDA，由 core.config.resolve_engine 按平台默认选择）。
# 构建只安装依赖，**不下载任何 Whisper 模型**：模型在首次转录时按需经 Hugging Face
# 缓存机制下载，并落进 /data 卷（HF_HOME），换镜像 / 升级不会重复下载。
#
# 协议与 macOS reference deployment 完全一致（/health、/v1/transcriptions），远程认证由
# Cloudflare Access 承担；本容器不持有任何凭据。
FROM python:3.12-slim

# 用 uv 按锁文件精确安装依赖（与仓库内 uv.lock 一致，含 faster-whisper）。
COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /uvx /usr/local/bin/

# 非 root 运行；/data 是唯一可写根（模型缓存、已完成结果、日志都落在这里，由卷承载）。
RUN groupadd --system app \
    && useradd --system --gid app --home-dir /app --shell /usr/sbin/nologin app \
    && mkdir -p /app /data/huggingface /data/runtime /data/logs \
    && chown -R app:app /app /data

WORKDIR /app

# 先只拷贝依赖清单并按锁文件安装（利用层缓存）；--no-install-project 跳过项目打包，
# 服务代码随后直接以工作目录形式进入镜像（与仓库运行方式一致）。
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project --compile-bytecode

COPY . .

ENV PATH="/app/.venv/bin:${PATH}" \
    HF_HOME=/data/huggingface \
    READ_PODCAST_TRANSCRIPTION_DATA=/data/runtime \
    READ_PODCAST_LOG_DIR=/data/logs

USER app

EXPOSE 28100

CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "28100"]
