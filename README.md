# oh-my-superagent

研究用 **Super-agent 沙盘**：按 DeepSeek [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) 与 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的双层思路，在本地用 Node 跑通「一个仓库 + GitHub/GitLab/飞书」。

**不是生产助手。** 用来理解：谁接单、谁干活、谁对人说话、默认为什么少说话。

| 文档 | 内容 |
| --- | --- |
| 本 README | 怎么跑、面板剧本、配置、目录 |
| [docs/design.md](docs/design.md) | 理念、领域模型、状态机/权限/可靠性契约 |
| [docs/design-review.md](docs/design-review.md) | 评审落地任务清单（P0–P2） |
| [docs/walkthrough.md](docs/walkthrough.md) | 一条请求从 webhook 到回帖的逐步对照 |

核心原则：**占用尽量少的人类注意力，交付尽量多的价值。**

---

## 三分钟心智模型

```
人在 Issue/飞书说话
        │
        ▼
   Gate（名单/@，滤噪音）
        │
   ┌────┴────┐
   │ Router  │  ← 主会话：接不接、怎么对外说（不改代码）
   └────┬────┘
        │ 建 Ticket
        ▼
   ┌─────────┐
   │ Worker  │  ← 独立 worktree：分析/改代码，只写 report
   └────┬────┘
        │ relay
        ▼
   Router 用 reply 发回原会话（默认自动发）
```

| 角色 | 干什么 | 不干什么 |
| --- | --- | --- |
| **Router** | 路由、授权、对外说话 | 不改业务代码 |
| **Worker** | 真正分析/改仓库 | 不直接对人说话 |
| **Watchdog** | 巡检卡住的工单并 retry | 不接新需求 |
| **人** | 名单、失败工单、设计决策 | 不必盯着每一步工具调用 |

---

## 环境

- Node **≥ 24**（用内置 `node:sqlite`、直接跑 TypeScript）
- 离线 demo：无 token、无模型
- 真模型：本机已登录 [`claude`](https://docs.anthropic.com/en/docs/claude-code) CLI

```bash
npm install
```

---

## 两种跑法

### A. 离线 mock（测骨架）

```bash
npm run demo
# → http://127.0.0.1:7878
```

- Router = 确定性 mock（按命令接单、转发 report）
- Worker = `mock-agent`（扫文件、改 `"A" → "B"`，不调模型）
- 来源 = dry-run（消息打控制台，不真推 PR）

适合：理解 Ticket / observe / 交还 / 面板，不花钱、不联网。

### B. 真 Claude CLI（简陋但真）

```bash
npm run demo:real
```

配置见 [`examples/real.config.json`](examples/real.config.json)：

```json
"router": { "agent": "claude" },
"executor": { "agent": "claude" }
```

### C. Worker = 本地 DeepSeek Harness（`dsh headless`）

前提：本机有 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码，且已 `pnpm install`（可用 `tsx`）。

```bash
# 默认 examples/dsh.config.json 里 dshRoot 指向 ../deepseek-harness
# 或: export DSH_ROOT=/path/to/deepseek-harness
# 或: export DSH_BIN=/path/to/dsh
npm run demo:dsh
```

| 层 | 行为 |
| --- | --- |
| Router | 仍可用 mock（省调用） |
| Worker | `dsh --profile headless`；read → `--permission-mode read-only`，write → `workspace-write` |
| 宿主 | 继续强制 Outbox / git shim；Harness 沙箱是额外一层 |


| 层 | 实际行为 |
| --- | --- |
| Router | `claude -p --tools ''` + [`prompts/router.md`](prompts/router.md) → 吐 JSON `actions` → 宿主执行 `orchestrator_*`；失败回退 mock |
| Worker | `claude` 在独立 worktree 里跑 [`prompts/worker.md`](prompts/worker.md) |

面板侧栏应显示 `Router: claude` / `Worker: claude`；概览日志出现 `claude round` / `tool orchestrator_…`。

---

## 面板：建议点一遍的剧本

打开 http://127.0.0.1:7878 → **模拟事件**：

| 顺序 | 预设 | 你应看到 |
| --- | --- | --- |
| 1 | Day-1：summarize | Router 接单 → 自动发确认 → Worker 分析 → Router 转发结果（`outbound: auto`，无需批准） |
| 2 | 跟进：要求修复 | 只读工单 **交还** → 新可写 Ticket → 分支提交 → 开 PR（dry-run） |
| 3 | observe：未呼叫但像 bug | **评估** 记 `would_accept`，**不建**工单 |
| 4 | 陌生人呼叫 | `not_a_member`，忽略 |
| 5 | Watchdog 立即巡检 | 概览出现巡检记录；卡住工单可被 retry |

命令行等价：

```bash
npm run simulate -- github issue --number 12 --user alice \
  --title "登录崩溃" --text "/agent summarize 手机号注册用户登录报错"
```

更细的逐步对照见 [docs/walkthrough.md](docs/walkthrough.md)。

---

## 人对 agent 说什么

在 Issue / PR 评论或飞书里：

```text
/agent <动词> <请求>
@agent <动词> <请求>
```

| 动词（中/英） | Mandate 能力 | 典型用途 |
| --- | --- | --- |
| summarize / analyze / ask，总结 / 分析 / 问 | **read** | 只读分析，不改文件 |
| fix / implement / change，修复 / 实现 / 修改 | **write** | 改代码、提交、提 PR |
| stop / 停止 | — | 停掉该线程上的工单 |

不认识的动词按 `ask`（只读）处理。能力写在不可变 **Mandate** 里：只读工单上有人要求改代码 → Worker **交还** → Router 再开可写 Ticket。

---

## 配置要点

本地私密配置：`superagent.config.json`（已 gitignore）。从示例复制：

```bash
cp superagent.config.example.json superagent.config.json
```

| 键 | 含义 | 常用值 |
| --- | --- | --- |
| `policy.mode` | 主动接单 | `observe`（默认）→ 确认判断后改 `auto` |
| `outbound` | 对外消息 | `auto`（默认）/ `review`（草稿等人批） |
| `router.agent` | Main Session | `mock` / `claude` |
| `executor.agent` | Worker | `mock` / `claude` / `codex` |
| `policy.sources.*.allowed` | 谁可以派活 | 各来源自己的身份 id |

接真 GitHub / 飞书：填 token 环境变量与 webhook（见示例配置注释字段）。服务默认可只绑 `127.0.0.1`；可用 `http.webhookPort` 单独暴露 webhook。

---

## 目录（解题 vs 调度）

```
src/core/          Engine：唯一写领域状态（Ticket / Eval / Mandate）
src/router/        Main Session：claude / mock、orchestrator 工具
src/executor/      Worker：worktree、CLI、report —— 真正改代码
src/watchdog/      外部巡检
src/policy.ts      Gate、observe/auto、策略版本
src/sources/       GitHub / GitLab / 飞书 webhook
src/store/         SQLite、effects、Outbox
src/panel/         管理面板
prompts/           router.md / worker.md / assess.md
scripts/demo-repo.ts   生成被修的示例仓库（greet 拼写、login 崩溃）
docs/              design + walkthrough
```

| 问题 | 看哪里 |
| --- | --- |
| 业务代码哪里坏了？ | `examples/demo-repo`（由 demo-setup 生成） |
| 谁在修它？ | `src/executor/` + `prompts/worker.md` |
| 谁决定接单、谁回帖？ | `src/router/` + `prompts/router.md` |
| 为什么没接？ | Gate / `policy.mode` / 允许列表 → `docs/design.md` |

---

## 开发

```bash
npm test          # 领域 + 来源 + e2e（mock）
npm run typecheck
```

测试默认 mock，不依赖本机 Claude。

---

## 许可

MIT
