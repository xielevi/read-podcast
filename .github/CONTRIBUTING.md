# 参与贡献

欢迎参与 Read Podcast 的开发与建设！无论是报告问题、完善文档还是提交代码，我们都非常欢迎。

在开始之前，请花几分钟阅读以下指引。

---

## 核心原则与架构事实源

Read Podcast 遵循清晰、精简的架构边界与设计不变量：

- **架构事实源**：项目的架构与设计决策以 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) 和 [`AGENTS.md`](../AGENTS.md) 为准。**凡涉及架构边界、数据持久化位置、任务执行所有权或网络拓扑的改动，必须先更新 `docs/ARCHITECTURE.md` 中的设计决策与不变量说明。**
- **避免过早抽象**：在出现第二个具体实现之前，不引入通用抽象层（例如不要过早引入 `OutputBackend` 抽象接口、多后端切换器或设置项开关）。保持现有实现标识符稳定（如 `transcription_service/`、`TRANSCRIPTION_SERVICE_*`、D1 字段名与 API 路由）。
- **隐私与凭据安全**：绝对不要向代码库、Pull Request、Issue 提交任何真实密钥、Token、Cloudflare 账号 ID、数据库 ID、私有仓库名、私人播客订阅源或本机绝对路径（见 `.gitignore`）。文档与示例必须统一使用规范占位符（如 `your-domain.example`、`your-github-username`、`your-manuscript-repository`、`podcasts/transcripts`）。
- **系统自足性**：本仓库保持自足，运行、构建、测试、部署与升级仅依赖本仓库内的代码与脚本。

---

## 本地开发环境

### 前置要求

- **Node.js**：20.x 或更高版本，以及 `npm`
- **Python / uv**（仅当修改转录服务 `transcription_service/` 时需要）：Python 3.10+ 与 [`uv`](https://docs.astral.sh/uv/)

### 快速开始

```bash
# 1. 安装 Node.js 依赖
npm ci

# 2. 配置本地环境变量
cp .dev.vars.example .dev.vars

# 3. 初始化并应用本地 D1 数据库迁移
npm run db:migrate:local

# 4. 启动本地开发服务（默认监听 http://localhost:8787）
npm run dev
```

本地开发环境下，`/` 为公开浏览视图，`/manage` 为主人管理视图（本地不经过 Cloudflare Access 拦截，D1 与 R2 由 Wrangler 本地模拟）。

### 本地运行转录服务（可选）

如需端到端测试完整的转录与生成链路，可在本地启动转录服务（参考环境为 Apple Silicon Mac）：

```bash
cd transcription_service
uv sync --locked
bin/run-service     # 监听 127.0.0.1:28100
bin/run-mlx         # 监听 127.0.0.1:21567
```

并在 `.dev.vars` 中配置好你的 `REFINER_API_KEY`、`GITHUB_TOKEN` 以及稿件仓库信息。

---

## 质量检查与本地验收

提交代码前，请确保在本地完整运行并全数通过以下验收命令：

```bash
# 1. TypeScript 类型检查与 Vitest 测试套件
npm run check

# 2. 前端语法检查与打包产物一致性校验
npm run check:frontend

# 3. 转录服务测试套件（如修改了 transcription_service/）
UV_CACHE_DIR=/tmp/read-podcast-edge-uv-cache uv run --directory transcription_service pytest -q

# 4. 验证 Worker 打包与配置有效性（Dry Run，不产生实际部署）
npx wrangler deploy --dry-run
```

`public/app.js` 是 `public/js/` 分片的生成物，不入库；`npm run check:frontend`、`wrangler dev/deploy` 与 Docker 构建都会自动重新生成。

---

## 提交与 Pull Request 规范

### 分支管理

- 开发应在独立特性分支或 worktree 中进行（如 `feat/issue-37-community-docs` 或 `fix/some-bug`），请勿直接修改或向主分支推送未评审的代码。

### 提交信息规范 (Git Commit Messages)

提交信息应采用清晰的祈使句，推荐遵循 Conventional Commits 格式：

- `feat:` 新增功能
- `fix:` 修复缺陷
- `docs:` 仅文档更新
- `refactor:` 代码重构（不改变外部行为）
- `test:` 增加或修改测试
- `chore:` 构建过程、依赖更新或辅助工具变动

示例：
```bash
git commit -m "feat: support custom retry backoff in processing workflow (#12)"
git commit -m "docs: clarify Free-plan subrequest limits in deployment guide"
```

### 提交 Pull Request

1. 保持 PR 聚焦，避免大而全的无关修改；优先采用小而可验证、可回退的改动。
2. 按照 [PR 模板](pull_request_template.md) 完整填写内容：
   - 清楚说明改动动机、具体实现与设计权衡。
   - 关联对应的 Issue（如 `Fixes #37`）。
   - 明确标明是否涉及数据库迁移（migrations）、R2 规则、环境变量或部署变更。
   - 附上本地验收命令的执行结果与手动测试记录。
3. 检查并确保没有引入任何真实密钥、个人域名、生产 Token 或敏感数据。

---

## 数据库迁移与升级兼容

- **添加迁移**：当修改数据表结构时，请在 `migrations/` 下添加按序递增的 SQL 文件（如 `migrations/0022_some_change.sql`）。
- **向后兼容与不变量**：
  - 严禁级联删除已成稿的 `articles` 记录。
  - 迁移需安全处理升级时的活跃任务（active tasks），避免任务丢失或成为死锁的僵尸任务。
  - 迁移文件必须在 `test/migrations.test.ts` 中补充相应的 SQLite 迁移测试。
- **破坏性变更说明**：若包含破坏性变更或需要用户在升级时执行特定操作，请参考 [`docs/UPGRADING.md`](../docs/UPGRADING.md)，并在 PR 和 Release Notes 中显式说明迁移与排空指引。
