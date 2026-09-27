## 改动说明 (Summary of Changes)
<!-- 清晰阐述本次 PR 解决的问题、主要改动内容与设计决策 -->

## 关联 Issue (Related Issues)
<!-- 例如 Fixes #37 或 Refs #30 -->
Fixes #

## 改动分类 (Type of Change)
- [ ] Bug fix (缺陷修复)
- [ ] New feature (新功能)
- [ ] Documentation (仅文档变更)
- [ ] Refactoring (代码重构，无外部行为变化)
- [ ] Performance / hardening (性能优化或安全加固)

## 是否涉及迁移或部署变更 (Migrations & Deployment Impact)
- [ ] 包含 D1 数据库结构变更 (已提供递增的 `migrations/XXXX_*.sql`)
- [ ] 包含 R2 存储桶规则或生命周期前缀变更 (见 `docs/DEPLOYMENT.md`)
- [ ] 包含环境变量、Wrangler Secret 或 `.deploy.env` 变更
- [ ] 包含 Cloudflare Access / Tunnel 策略或路径变更
- [ ] 包含破坏性变更 (Breaking Change) - 已在下方或 `docs/UPGRADING.md` 说明升级与排空方案
- [ ] 不涉及任何迁移或部署变更

## 验证方式与测试记录 (Verification & Testing)
- [ ] `npm run check` (TypeScript 类型检查 + 单元测试通过)
- [ ] `npm run check:frontend` (前端语法与打包产物一致性通过)
- [ ] `UV_CACHE_DIR=/tmp/read-podcast-edge-uv-cache uv run --directory transcription_service pytest -q` (若修改转录服务)
- [ ] `npx wrangler deploy --dry-run` (部署配置与 bundle 验证通过)
- [ ] 手动测试 / 冒烟测试记录（如下）：
<!-- 描述手动测试步骤与结果（注意日志与输出脱敏） -->

## 安全与架构规范自查 (Security & Invariants Checklist)
- [ ] **绝无凭据泄漏**：未包含任何真实密钥、Token、域名、生产账号 ID 或本机绝对路径
- [ ] **占位符规范**：示例与文档统一使用 `your-domain.example`、`your-github-username` 等规范占位符
- [ ] **事实源同步**：若涉及架构、拓扑或设计决策变更，已首先更新 `docs/ARCHITECTURE.md`
- [ ] **不变量遵循**：符合 `AGENTS.md` 中声明的产品边界与架构不变量
