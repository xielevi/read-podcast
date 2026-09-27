---
name: 部署问题 (Deployment Issue)
about: 部署 Cloudflare Workers、D1/R2、Access、Tunnel 或转录服务时遇到困难
title: "deploy: "
labels: ["deployment"]
assignees: ""
---

> [!CAUTION]
> **严禁在此张贴任何真实密钥与敏感凭据！(CRITICAL: REDACT ALL CREDENTIALS)**
> 部署排障极易不慎粘贴敏感信息。在提交此 Issue 前，请务必仔细核对并清除：
> - 真实域名（必须替换为 `your-domain.example` 或 `transcribe.your-domain.example`）
> - 所有密钥与 Secret（`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `GITHUB_TOKEN`, `REFINER_API_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` 等）
> - Cloudflare 账号 ID (Account ID)、D1 数据库 ID (Database ID)、私有仓库完整地址或个人邮箱

### 遇到问题的部署环节 (Deployment Phase)
<!-- 请勾选出错的环节 -->
- [ ] 域名与 DNS 解析
- [ ] D1 数据库创建或数据迁移 (`npm run db:migrate:remote`)
- [ ] R2 存储桶与生命周期规则配置 (`refined/`, `raw/`, `uploads/`)
- [ ] 部署配置与环境变量注入 (`.deploy.env` / `npm run deploy`)
- [ ] Cloudflare Access 路径策略与权限规则 (`/manage*`, `/api/control/*`)
- [ ] 转录服务本地安装或启动 (`deploy/macos/install.sh`, `bin/run-service`)
- [ ] Cloudflare Tunnel 与 Service Token 连通性
- [ ] 升级现有部署 (`scripts/preflight_upgrade.sh`)
- [ ] 其他

### 故障现象与错误输出 (Symptoms & Sanitized Error Output)
<!-- 简要说明报错现象，并粘贴脱敏后的终端输出或日志 -->
```text

```

### 自检与诊断命令执行结果 (Diagnostic Outputs)
<!-- 请附上相关排障命令的执行输出（请确认已脱敏）： -->

1. 部署参数预览（若卡在部署步骤）：
```bash
node scripts/deploy.mjs --print-args
```
输出：
```text

```

2. 转录服务健康检查：
- 宿主机本地：`curl -fsS http://127.0.0.1:28100/health`
- 经过 Access + Tunnel（在终端执行，使用环境变量而非真实明文）：
```text

```

3. 升级预检（若是升级已有部署）：
```bash
scripts/preflight_upgrade.sh
```

### 部署环境简况 (Deployment Environment)
- **操作系统 / 硬件平台**: <!-- 例如 macOS 15.0 Apple Silicon M3 / Ubuntu 24.04 x86_64 -->
- **Node.js 版本**: <!-- node -v -->
- **uv / Python 版本**: <!-- uv -V / python3 -V -->
- **Cloudflare 计划**: Workers Free / Workers Paid

### 期望达到的状态与补充说明 (Expected Outcome & Notes)
<!-- 描述你期望达到的运行状态，或补充其他背景 -->
