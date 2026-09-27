# 参与贡献

欢迎提 Issue 和 Pull Request。

> [!NOTE]
> 本文件正在按新架构更新社区模板与指引（跟踪于 issue #37）。开发与校验请参考以下命令与 `AGENTS.md`。

## 开发环境

```bash
npm ci                          # 安装 Node.js 依赖与工具链
npm run check                   # 运行 TypeScript 类型检查与 Vitest 测试
npm run check:frontend          # 检查前端脚本语法与构建一致性
```

如需验证外部转录服务：
```bash
uv sync --directory transcription_service --dev --locked
uv run --directory transcription_service pytest -q
```

## 约定

- 架构边界见 [`AGENTS.md`](../AGENTS.md) 与 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)；改动架构前先更新其中的设计决策小节。
- 业务生命周期由 Cloudflare 拥有，转录服务为外部独立无状态计算节点。
- 不提交密钥、真实订阅、音频、转录稿、数据库或本机绝对路径（见 `.gitignore`）。
- 提交 PR 前请确保 `npm run check` 与 `npm run check:frontend` 通过。

## 提交信息

使用清晰的祈使句，可用 `feat:` / `fix:` / `docs:` / `refactor:` 前缀。
