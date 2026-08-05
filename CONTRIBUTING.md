# 参与贡献

欢迎提 Issue 和 Pull Request。

## 开发环境

```bash
uv sync --dev --extra mlx      # 安装依赖（含开发与 MLX 可选组件）
uv run pytest -q               # 运行测试
```

## 约定

- 架构边界见 [`AGENTS.md`](AGENTS.md) 与 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；改动架构前先更新其中的设计决策小节。
- 语音转录固定使用 macOS Apple Silicon 原生 MLX，不引入 Faster-Whisper、自包含 CPU 镜像或宿主硬件自动选型。
- 不要提交密钥、真实订阅、音频、转录稿、数据库或本机绝对路径（见 `.gitignore`）。
- 提交 PR 前请确保 `uv run pytest -q` 通过。

## 提交信息

使用清晰的祈使句，可用 `feat:` / `fix:` / `docs:` / `refactor:` 前缀。
