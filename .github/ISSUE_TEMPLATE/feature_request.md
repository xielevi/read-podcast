---
name: 功能建议 (Feature Request)
about: 为 Read Podcast 提出新功能或体验改进建议
title: "feat: "
labels: ["enhancement"]
assignees: ""
---

> [!NOTE]
> **产品边界与设计不变量说明**：
> Read Podcast 是一个极简、自足的个人播客订阅与长文稿阅读系统。
> 在提出新功能建议前，请先了解项目在 [`AGENTS.md`](../../AGENTS.md) 与 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) 中明确设定的设计边界：
> - **不设网盘同步、第三方 OAuth 连接器或对话式 AI 助手**（按设计明确排除）。
> - **不设多租户与复杂用户系统**（单一主人模式，基于 Cloudflare Access 隔离）。
> - **避免过早抽象**（在出现第二个具体实现前不引入抽象接口与多后端切换）。
> - **保持 Workers Free 计划友好**（必须考量 Cloudflare Free 计划的 CPU 与子请求限额）。

### 需求背景与痛点 (Problem Statement / Use Case)
<!-- 这个需求解决了什么问题？在什么场景下遇到不便？ -->

### 期望的方案描述 (Proposed Solution)
<!-- 清晰描述你希望新增或改变的行为与交互流程 -->

### 考虑过的替代方案 (Alternatives Considered)
<!-- 你是否尝试过其他替代解法或临时融通方案？为什么不够理想？ -->

### 对现有架构与资源配额的影响 (Impact on Architecture & Limits)
<!-- 是否涉及 D1 表结构迁移、R2 存储生命周期、或 Workers CPU/子请求额度的增加？ -->

### 补充上下文 (Additional Context)
<!-- 任何其他草图、参考链接或补充说明 -->
