# 配置就在这个目录

**你要改的所有东西都在这里，两个文件：**

| 文件 | 放什么 | 怎么改 |
| :--- | :--- | :--- |
| `config/config.yaml` | 普通设置：AI 服务地址、模型、转录后端、输出目录、订阅列表 | 手动编辑，或用网页「设置」面板 |
| `config/secrets.env` | 密钥：API Key、访问口令 | 手动编辑，或用网页「设置」面板 |

两个文件都**不会**进版本库，`git pull` 不会覆盖它们。`secrets.env` 权限是 `0600`（只有你自己能读）。

> **手动编辑和网页面板作用于同一份配置**，改哪边都行，不会互相冲突。
> 网页面板保存后立即生效，不用重启。

---

## 项目里其他看起来像配置的文件

| 文件 | 是什么 | 要不要改 |
| :--- | :--- | :--- |
| `modules/config.default.yaml` | 内置默认值，随版本更新 | ❌ **不要改**。改了 `git pull` 会冲突。想看有哪些可用选项和示例，把它当**参考手册**读，然后把要改的项抄到 `config/config.yaml` |
| 根目录 `.env` | 旧版密钥位置，仍然能用 | 建议把里面的密钥搬到 `config/secrets.env`，统一到一处。Docker 用户如果靠 Compose 的 `${REFINER_API_KEY}` 变量替换，可以继续留着 |
| `docker-compose.yml` 的 `environment:` | 部署方注入的环境变量 | 只有 Docker 部署才需要动。**这里的值优先级最高**，会让网页面板对应字段变成灰色只读 |

---

## 优先级（高的覆盖低的）

```
docker-compose.yml / shell 里注入的环境变量   ← 最高，会锁定网页面板
        ↓
config/secrets.env  ＋  config/config.yaml    ← 你和网页面板都写这里
        ↓
根目录 .env                                    ← 旧版位置，向后兼容
        ↓
modules/config.default.yaml                    ← 内置默认值，只读
```

如果网页面板里某个字段是**灰色只读**，说明它被最上面那层接管了——去改 `docker-compose.yml` 或启动脚本，改网页没用。

---

## 常见任务

**换 AI 服务商**——`config/config.yaml`：

```yaml
refiner:
  api_base: https://api.deepseek.com/v1
  model: deepseek-chat
```

Key 写进 `config/secrets.env`：

```
REFINER_API_KEY=sk-你的key
```

**改成稿保存位置**——`config/config.yaml`：

```yaml
paths:
  obsidian_markdown_dir: /Users/你/Obsidian/播客
```

更多可用选项见 `modules/config.default.yaml` 的注释，或直接用网页右上角的「设置」。
