FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface

WORKDIR /service

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

RUN useradd --create-home --uid 10001 app \
    && mkdir -p /models \
    && chown -R app:app /models /service

COPY --chown=app:app app.py ./app.py

USER app

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
    CMD ["python", "-c", "from urllib.request import urlopen; assert urlopen('http://127.0.0.1:8000/health').status == 200"]

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
