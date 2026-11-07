# oh-my-superagent

按 DeepSeek [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) / [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 思路做的**研究用 demo**：**一个仓库 + GitHub/GitLab + 飞书**。

核心原则：**占用尽量少的人类注意力，交付尽量多的价值。**

- **Main Session（Router）**：常驻全局路由；工具接单、收 Worker 汇报、**统一对外说话**；不执行具体任务。
- **Worker**：每工单独立 worktree / 会话；只写结构化 report，从不直接对人说。
- **Watchdog**：外部巡检，卡住工单可自动 retry。
- Gate Fast Path 滤噪；订阅线程跟进直通 Worker；默认 **observe** + **outbound: auto**。

细节见 [docs/design.md](docs/design.md)。这是理念沙盘，不是生产助手。

## 离线 mock（测骨架，不需要模型）

```bash
npm install
npm run demo         # http://127.0.0.1:7878 · Router/Worker 都是 mock
```

## 真 Claude CLI（简陋但真）

本机已登录 `claude`：

```bash
npm run demo:real    # Router + Worker 都走 claude -p
```

配置见 `examples/real.config.json`：

```json
"router": { "agent": "claude" },
"executor": { "agent": "claude" }
```

怎么跑的（简陋版）：

- **Router**：`claude -p --tools ''`，读 `prompts/router.md` + inbox；模型吐 JSON `actions`；宿主执行 `orchestrator_*`。失败则回退 mock。
- **Worker**：现有 CLI 后端，真跑 `prompts/worker.md`，worktree 隔离。
- 测试 / `npm run demo` 仍默认 mock，保证离线 CI。

面板 **模拟** → Day-1：看概览 Router 日志里应有 `claude round` / `tool orchestrator_…`。

## 指令

`/agent <动词> <请求>` 或 `@agent <动词> <请求>`：

| 动词 | 能力 |
| --- | --- |
| summarize / analyze / ask，总结 / 分析 / … | read |
| fix / implement / change，修复 / 实现 / … | write |
| stop / 停止 | 停止工单 |

## 接真实环境

复制 `superagent.config.example.json`，填 token 与仓库路径。把 `router.agent` / `executor.agent` 设成 `claude` 即可。

## 面板

观察 **Router 日志、开放工单、Watchdog、已发出消息**。人只处理：Worker 提问、失败/受阻工单、评估异常、加入允许列表。

## 开发

```bash
npm test
npm run typecheck
```

```
src/core/        Engine（唯一写者）、Ticket / Eval
src/router/      Main Session（claude/mock）、tools
src/executor/    Worker（mock / claude / codex）——真正改代码的地方
src/watchdog/    外部 Control Loop
src/policy.ts    Gate、observe/auto
prompts/         router.md / worker.md / assess.md
docs/design.md   架构说明
```

被修的示例仓库由 `scripts/demo-repo.ts` 生成（`src/greet.js` 拼写、`src/login.js` 崩溃）。

## 许可

MIT
