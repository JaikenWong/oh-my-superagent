# 逐步对照：一条请求怎么变成回帖

配合面板 **模拟事件** 或 `npm run simulate`。默认假设 `npm run demo`（mock）或 `demo:real`（claude），`outbound: auto`，`policy.mode: observe`。

---

## 0. 先认两样东西

### 被修的仓库（业务代码）

`npm run demo` 会生成 `examples/demo-repo`：

| 文件 | 植入的问题 |
| --- | --- |
| `src/greet.js` | 返回 `"Helo, …"`（拼写错） |
| `src/login.js` | `user.email.toLowerCase()`，手机号用户无 email 会崩 |

Agent **改的是这份仓库的 worktree 副本**，不是 `src/router` 自己。

### 谁在动

| 阶段 | 组件 | 你怎么确认 |
| --- | --- | --- |
| 滤噪 / 排队 | Engine + Gate | **评估** / **会话** 页 |
| 接单、回帖 | Router | 概览 **Router 日志** |
| 改代码 / 分析 | Worker | 工单页阶段、产物、分支 |
| 卡住救援 | Watchdog | 概览巡检记录 |

---

## 1. Day-1：`/agent summarize …`

### 你做什么

面板预设 **「总结一个 bug」**，或：

```bash
npm run simulate -- github issue --number 12 --user alice \
  --title "手机号注册用户登录崩溃" \
  --text "/agent summarize 手机号注册的用户登录时报错 login crash"
```

### 系统里发生什么

```text
webhook / simulate
  → Source 译成 Trigger（alice, addressed, Thread=github:issue:12）
  → Engine.receive：进 pending
  → evaluateDue：开 Eval；Gate → explicit
  → Router inbox: candidate
  → orchestrator_eval_decide(accept, capability=read)
       建 Ticket + Mandate(read) + Assignment + worktree
  → orchestrator_reply(acknowledgement)  → Outbox → 「已发送」
  → Worker 回合：读 login.js 等，report.reply = 分析文案
  → Engine relay（不直接发帖）
  → Router orchestrator_reply(result) → Outbox → 「已发送」
  → Ticket completed
```

### 你应看到

1. **工单**：出现只读 Ticket，最终阶段「已完成」。
2. **对外消息**：确认 + 分析结果两条（auto，无需点批准）。
3. mock 时结果里常提到 `src/login.js`；claude 时文案由模型写，结构仍是 report → Router 转发。
4. `demo:real` 时 Router 日志含 `claude round` / `tool orchestrator_…`。

### 对应代码

| 步骤 | 文件 |
| --- | --- |
| 接 webhook | `src/sources/github.ts`、`src/app/runtime.ts` `ingest` |
| Gate / Eval | `src/policy.ts`、`src/core/engine.ts` |
| Router 接单 | `src/router/mock-router.ts` 或 `claude-router.ts` |
| Worker | `src/executor/executor.ts` + `mock-agent.ts` / claude |
| 发帖 | `src/store/outbox.ts`、`src/app/replies.ts` |

---

## 2. 跟进：只读工单上要求修复

### 你做什么

同一 Issue #12：

```text
/agent fix src/greet.js "Helo" -> "Hello"
```

### 系统里发生什么

```text
Trigger 到达已订阅的 Thread
  → Fast Path：直达（已结束的）只读 Ticket，并 resume
  → Worker：判定超出 Mandate(read) → handbacks
  → 消息回 Eval → Router 再建 Ticket(write)
  → Worker：改 greet.js、commit、report.pull_request
  → 宿主 Outbox 开 draft PR（dry-run 不真推远端）
  → Ticket 跟随 PR Thread；合并后 ended=merged
```

### 你应看到

- 旧只读工单：**交还** 后变 idle，不重复长篇分析。
- 新可写工单：分支 `superagent/<name>` 有提交；main 未改。
- 有 PR 提案 / 链接宣布（auto 下自动走完）。

### 要点

**Mandate 不可变。** 要写权限 = 新 Ticket，不是把旧只读工单「升级」。

---

## 3. observe：未呼叫但像 bug

### 你做什么

alice **不**写 `/agent`，只说带 crash / 报错的话（命中规则关键词）。

### 系统里发生什么

```text
Gate → inferred（名单内未呼叫）
  → Router / assessor 研判「会接」
  → policy.mode=observe → Decision ignore + audit.would_accept
  → 不建 Ticket，不说话
```

### 你应看到

- **评估** 页：忽略，且标记「本会接单」类信息。
- 开放工单数不变。
- 你确认判断靠谱后，再把设置里 `policy.mode` 改成 `auto`。

---

## 4. 陌生人呼叫

mallory 不在 `allowed` → Gate `not_a_member` → ignore。  
概览可出现「不在名单里的人呼叫了 agent」→ 一键加入允许列表。

---

## 5. 停止

```text
/agent stop
```

显式 stop：Router / Engine 结束该 Thread 上 live Ticket，撤回未发草稿（若有）。

---

## 6. Watchdog

面板点 **立即巡检**，或等定时（约 60s）。

- 若有 `failed` / `blocked` 且可 retry → 新建 Assignment、note Worker。
- 概览列出最近动作。

---

## 对照表：假 vs 真

| 现象 | mock demo | demo:real |
| --- | --- | --- |
| 分析文案 | `mock-agent` 模板 | Claude 按 `worker.md` 写 |
| 修 `"Helo"` | mock 正则替换 | Claude 编辑 + commit |
| 接单决策 | `parseCommand` / heuristic | Claude 吐 `orchestrator_eval_decide` |
| 回帖 | mock 转发 report | Claude 可改写后再 `orchestrator_reply` |
| 架构路径 | **相同** | **相同** |

骨架（Gate / Ticket / relay / Outbox）两边共用；变的是「谁填决策与文案」。

---

## 卡住时看哪

| 症状 | 先查 |
| --- | --- |
| 完全没反应 | 来源 dry-run？允许列表？面板是否暂停？ |
| 有 Trigger 无 Ticket | **评估**：ignore / observe / not_a_member？ |
| 有 Ticket 无回帖 | Router 日志；Outbox 是否 `review` 卡草稿；Worker 是否缺 report |
| Worker 失败 | 工单阶段 person/failed → 重试或 Watchdog |
| claude 报错 | 本机 `claude` 是否登录；日志是否写了 fallback mock |
