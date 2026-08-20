FROM ghcr.io/astral-sh/uv:0.11.29-python3.12-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    READ_PODCAST_CONFIG=/config/config.yaml \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project && uv cache clean

COPY app ./app
COPY modules ./modules
COPY scripts ./scripts

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["uv", "run", "--no-sync", "python", "-c", "from urllib.request import urlopen; assert urlopen('http://127.0.0.1:8080/api/read-podcast/health').status == 200"]

# modules/config.default.yaml 随代码提供默认值；/config 卷只保存用户覆盖与机密。
CMD ["sh", "-c", "mkdir -p /config && touch /config/config.yaml && exec uv run --no-sync uvicorn app.standalone:app --host 0.0.0.0 --port 8080"]
