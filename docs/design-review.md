# Design Review → 实施任务清单

来源：对 [design.md](design.md) 的架构评审（评分 7.5/10）。  
目标：把「应该发生什么」补成「系统如何保证一定正确发生」——优先写清契约与不变量，再按阶段改代码。

用法：Coding Agent 按任务 ID 逐项落地。每项标明 **改文档 / 改代码 / 仅约束**，以及验收标准。

---

## 总原则

**保留（不要改坏）：**

1. Router / Worker 双层
2. Engine 作为领域状态唯一写者
3. Mandate 不可变
4. Outbox 作为外部写唯一出口
5. 本地 Node + SQLite + Worktree（不引入 Redis / Kafka / Temporal / K8s）

**本轮重点对象：** Ticket · Assignment · Mandate · Outbox 的状态机与不变量。

**全局不变量（后续各章必须对齐）：**

| ID | 不变量 |
| --- | --- |
| INV-1 | Engine 是领域状态的唯一写者 |
| INV-2 | 一个 Ticket 同一时刻最多一个有效 Running Assignment |
| INV-3 | Worker 不能直接产生外部副作用（对人说 / 开 PR / push） |
| INV-4 | Worker 不能自行扩大 Mandate |
| INV-5 | Outbox 是所有外部写操作的唯一出口 |
| INV-6 | 过期 Assignment 的迟到 Report 不得影响当前 Ticket |
| INV-7 | Stop 后不得被自动 Retry 覆盖重启 |

---

## 阶段总览

| 阶段 | 目标 | 优先级 |
| --- | --- | --- |
| **P0 / 第一阶段** | 核心正确性：状态机、执行互斥、权限强制、Stop↔Retry | 必须 |
| **P1 / 第二阶段** | 可靠性：Outbox 幂等、Watchdog 恢复策略、输入队列、崩溃恢复 | 强烈建议 |
| **P2 / 第三阶段** | Runtime 完善：Router 上下文压缩、Domain Event、注入防护审计 | 后续 |

建议在 `design.md` 末尾新增四章（不推翻 0–8）：

| 新章节 | 内容 | 阶段 |
| --- | --- | --- |
| §9 状态机与并发控制 | Ticket/Assignment 转换、输入队列、执行互斥 | P0 |
| §10 权限与安全模型 | Mandate → Capability Enforcement、不可信 Trigger | P0 |
| §11 可靠性与恢复 | Retry、Crash Recovery、Outbox 幂等、Watchdog | P1 |
| §12 事件与可观测性 | Event Schema、Correlation、审计 | P2 |

每章末尾固定小节：**Invariants**（引用上表 + 本章特有条目）。

---

## P0 — 核心正确性（必须）

### DR-P0-01 · 在 design.md 增加 §9：Ticket / Assignment 状态机

| 项 | 内容 |
| --- | --- |
| **类型** | 改文档（先于代码） |
| **现状** | design.md 有概念，无完整状态转换；代码有 `Ticket.ended`、`AssignmentState`、`ReportState`、`ticketStage`，但未写成契约 |
| **要做** | 写清 Ticket 状态（或 stage）与 Assignment 生命周期，以及二者不同步时的规则 |
| **建议状态** | Ticket：Created → Accepted → Running / Waiting / Blocked → Completed / Failed / Stopped；Assignment：Pending → Running → Ended |
| **必须写明的不变量** | INV-2、INV-6；Retry 必须新建 Assignment，禁止覆盖旧执行记录；Stop 使当前执行失效，不只发进程信号 |
| **验收** | design.md §9 有状态图/表 + 转换触发条件 + Invariants；与 `model.ts` / `stage.ts` 术语对齐或明确「文档逻辑态 ↔ 代码字段」映射 |

### DR-P0-02 · Assignment generation / 过期 Report 拒绝

| 项 | 内容 |
| --- | --- |
| **类型** | 改文档 + 改代码 |
| **现状** | `Assignment` 有 `id`，无 `generation`；`Engine` 收 Report 时未见「非当前执行则丢弃」的显式校验 |
| **要做** | 引入 `generation: number`（或等价：仅接受 `latestAssignment.id` 且 `state === 'running'`）；Retry/新 Assignment 递增 generation；迟到 Report 忽略并记事件 |
| **涉及** | `src/core/model.ts`、`src/core/engine.ts`、`src/executor/`、必要时测试 |
| **验收** | 旧 Assignment 在新 Assignment 已 Running 后提交 Report → Ticket 状态不变；有可观测事件（如 `assignment.report_stale`） |

### DR-P0-03 · Stop 与 Retry 冲突规则

| 项 | 内容 |
| --- | --- |
| **类型** | 改文档 + 改代码 |
| **现状** | `canRetry` 仅看 `!ended && (waitsForPerson \|\| delivery)`；Watchdog `tick()` 对可重试工单直接 `retryTicket`；Stop 后语义需与 INV-7 对齐并写死 |
| **要做** | 文档定义：用户/Router Stop → Ticket ended(outcome=stopped)；Watchdog / 自动恢复**禁止**对 stopped 工单 Retry；人工显式「重新打开」另议（本阶段可不实现，只禁止自动重启） |
| **涉及** | `stage.ts` `canRetry`、`watchdog.ts`、`engine` stop/retry 路径、design.md §9/§11 |
| **验收** | stopped Ticket：`canRetry === false`；Watchdog 不调用 retry；测试覆盖 |

### DR-P0-04 · 在 design.md 增加 §10：权限与安全 + Capability Enforcement 契约

| 项 | 内容 |
| --- | --- |
| **类型** | 改文档（契约先落地）；执行层见 DR-P0-05 |
| **现状** | Mandate 不可变已有；执行侧主要靠 Prompt + `SUPERAGENT_CAPABILITY` 环境变量，非宿主强制 |
| **要做** | 定义链路：`Mandate → Capability Resolver → Execution Policy`；矩阵至少覆盖：读文件 / 改文件 / 跑测试 / git commit / git push / 开 PR / 跨仓 |
| **原则** | 权限由**宿主强制执行**，不依赖模型自觉；git push 屏蔽 ≠ 无网络外泄；第一版可用 FS 权限 + 命令白名单 + 宿主侧 API，不必上完整沙箱 |
| **信任边界** | Source 验签/身份；Gate 只准入不信内容；`Trigger.text/meta` 不可信；Worker 不得把 Trigger 当系统指令；Prompt Injection **不能**扩大 Mandate（INV-4） |
| **验收** | design.md §10 含能力矩阵 + 信任边界 + Invariants（INV-3/4）；明确「Prompt 只是辅助说明」 |

### DR-P0-05 · 宿主侧 Execution Policy（第一版最小强制）

| 项 | 内容 |
| --- | --- |
| **类型** | 改代码（最小可用）+ 文档交叉引用 |
| **现状** | `executor.ts` 传 `SUPERAGENT_CAPABILITY`、过滤宿主凭据；无命令/写盘强制 |
| **第一版范围（够用即可）** | read：禁止写工作区文件、禁止 `git commit`/`git push`、禁止经 Worker 调外部写 API；write：允许 worktree 内改文件与 commit；push / 开 PR / 对人回复仍只走宿主 Outbox |
| **实现建议** | Worker 启动前由宿主根据 Mandate 生成 policy；CLI/包装层拒绝违规命令；或 read 模式挂只读 worktree / 无写权限目录 |
| **不做（本阶段）** | 完整 OS 沙箱、细粒度网络 ACL、多层 seccomp |
| **验收** | 自动化或集成测试：read Mandate 下尝试写文件或 commit → 被宿主拒绝，而非仅靠模型「答应不写」 |

---

## P1 — 可靠性（强烈建议）

### DR-P1-01 · design.md §11：Watchdog = Detector + Recovery Policy

| 项 | 内容 |
| --- | --- |
| **类型** | 改文档 + 改代码（可分两步） |
| **现状** | Watchdog 偏自动重试器：`tick()` 对 `canRetry` 直接 Retry |
| **要做** | 拆职责：**Detector**（纯程序，不调 LLM）：超时 / 无进展 / Assignment 异常 / 进程失联；**Recovery Policy**：可安全重试 → Retry；外部副作用未知 → 暂停检查；需人决定 → 通知 Router；超限 → Failed |
| **策略表（文档必写）** | 进程异常退出→可重试；超时→先确认旧进程已死；外部 API 结果未知→不盲目重放；Git 中断→先查 worktree；连续失败→人工；用户 Stop→禁止自动重启（INV-7） |
| **参数** | 最大重试次数、退避、预算；记录在 Ticket/Assignment 或 settings |
| **验收** | 文档有 Detector/Policy 边界与决策表；代码至少：重试预算 + Stop 保护；副作用未知路径可先「只 note + 通知 Router」 |

### DR-P1-02 · Outbox 状态机与幂等

| 项 | 内容 |
| --- | --- |
| **类型** | 改文档 + 改代码 |
| **现状** | `ReceiptStatus = draft \| pending \| sent \| dropped`；有按 id 去重、draft 审批、同 Ticket+conversation 顺序；缺 `sending` / `failed` / `unknown` 与 idempotencyKey |
| **要做** | 扩展状态：`draft → pending → sending → sent \| failed \| unknown`（dropped 保留）；引入 `idempotencyKey`；`unknown` = 外部可能已成功但本地无确认 → 先 Source 查询，能确认则标 sent，否则人工或平台幂等重试 |
| **顺序契约（文档写清，代码已近似实现）** | 同一 Ticket + 同一 conversation 保序；非全局总序（除非另声明） |
| **验收** | 类型与持久化支持新状态；发送中崩溃可恢复到 sending/unknown 而非静默重复；文档说明 at-least-once + 幂等键语义 |

### DR-P1-03 · 订阅直通：输入队列与并发语义

| 项 | 内容 |
| --- | --- |
| **类型** | 改文档（对齐现有 `inputs` / `undelivered` / `taking`）；缺口补代码 |
| **现状** | Engine 已有输入队列与 taking 回收；design.md 未定义语义 |
| **文档必写** | Thread Subscription → Ticket Input Queue →（可选 Aggregator）→ Assignment → Worker Turn；执行中到达 → undelivered；下轮批量消费；Trigger ID 去重；human 输入优先；Stop 尽快中断；多 Ticket 订同一 Thread 时 fan-out 独立消费 |
| **验收** | design.md §9 含队列语义表；与 `engine.ts` 行为一致；若有合并策略（多条跟进合成一轮）需显式开关/规则，默认可「按批原样下发」 |

### DR-P1-04 · 宿主崩溃恢复流程

| 项 | 内容 |
| --- | --- |
| **类型** | 改文档 + 改代码（核对/补齐） |
| **现状** | Assignment 有 `recovery` 字段；需明确启动时扫描规则 |
| **要做** | 启动：扫描 Running Assignment / 无 Report 的执行；标记或重建执行意图；与 generation、进程存活检查联动；Outbox `sending`/`unknown` 进入恢复路径 |
| **验收** | 文档有 crash recovery 序列图；重启后无「双 Worker 同 Ticket 有效执行」（INV-2）；有测试或 demo 步骤 |

---

## P2 — Agent Runtime 完善（后续）

### DR-P2-01 · Router 上下文分层与压缩（仅约束可先记）

| 项 | 内容 |
| --- | --- |
| **类型** | 仅约束 → 后续改代码 |
| **问题** | Router 职责集中，长期会堆积 Ticket 摘要 / Report / Watchdog / 用户消息 |
| **契约** | Main Session 逻辑连续、物理可压缩：Current Inbox / Active Ticket Summary / Recent Decisions / Long-term Memory / Historical Ticket Index；历史 Report **不**永久塞进上下文；状态仍以 Engine+SQLite 为准（INV-1） |
| **验收（本阶段）** | design.md 记为约束即可；实现属后续迭代 |

### DR-P2-02 · Domain Event 与可观测性（§12）

| 项 | 内容 |
| --- | --- |
| **类型** | 改文档 → 逐步改 `events` 写入 |
| **建议 schema** | `eventId, eventType, occurredAt, ticketId?, assignmentId?, triggerId?, threadId?, correlationId, causationId?, payload` |
| **用途** | 链路：Trigger → Eval → Accept → Assignment → Report → Reply → Outbox；支撑面板与审计 |
| **验收** | design.md §12；存量事件逐步补字段，不要求一次改完 |

### DR-P2-03 · Prompt Injection 防护清单（执行层加固）

| 项 | 内容 |
| --- | --- |
| **类型** | 改文档（P0 信任边界已覆盖）+ 后续审计/测试 |
| **要做** | 系统提示与用户 Trigger 严格分区；Mandate 校验在工具/命令层；敏感路径审计事件 |
| **验收** | 有对抗用例列表（即使先手工测） |

---

## 实现差距速查（对照代码）

| 区域 | 观察 | 对应任务 |
| --- | --- | --- |
| `src/core/engine.ts` | 原子事务、Trigger 去重、输入队列较完整 | DR-P0-02、DR-P1-03/04 补契约与缺口 |
| `src/core/model.ts` | Ticket/Assignment/Mandate 模型较全；缺 generation / Outbox 新状态 | DR-P0-02、DR-P1-02 |
| `src/executor/executor.ts` | 并发限制、凭据隔离、capability 环境变量 | DR-P0-05 |
| `src/watchdog/watchdog.ts` | 巡检 + 直接 Retry | DR-P1-01、DR-P0-03 |
| `src/store/outbox.ts` | draft/pending/sent/dropped；顺序与 id 去重已有 | DR-P1-02 |

---

## Coding Agent 推荐执行顺序

```text
1. DR-P0-01  写 design.md §9（状态机 + 不变量）
2. DR-P0-04  写 design.md §10（权限矩阵 + 信任边界）
3. DR-P0-02  Assignment generation + 拒绝过期 Report（测）
4. DR-P0-03  Stop vs Retry（测）
5. DR-P0-05  最小 Execution Policy（测）
6. DR-P1-03  把输入队列语义写入 §9（对齐代码）
7. DR-P1-01  Watchdog Detector/Policy + 重试预算
8. DR-P1-02  Outbox 状态机 + idempotencyKey
9. DR-P1-04  Crash recovery 流程
10. DR-P2-*  文档约束先行，代码随迭代
```

**并行建议：** 文档任务（01/04）与代码任务（02/03）可由不同 Agent 并行，但代码必须以文档不变量为准；若冲突，先修文档术语映射再改代码。

---

## 任务状态模板（可选勾选）

```md
- [x] DR-P0-01 design.md §9 状态机
- [x] DR-P0-02 generation / stale report
- [x] DR-P0-03 Stop vs Retry
- [x] DR-P0-04 design.md §10 权限与安全
- [x] DR-P0-05 Execution Policy v1（shim + capability 矩阵；非完整 OS 沙箱）
- [x] DR-P1-01 Watchdog Detector + Policy（预算 / 副作用未知只 note）
- [x] DR-P1-02 Outbox 幂等与状态（sending/failed/unknown + idempotencyKey）
- [x] DR-P1-03 输入队列语义文档化
- [x] DR-P1-04 Crash recovery（Assignment + Outbox sending→unknown）
- [ ] DR-P2-01 Router 压缩（约束已写 §12）
- [ ] DR-P2-02 Domain Event schema（§12 契约；字段逐步补）
- [ ] DR-P2-03 Injection 对抗用例
```

**额外：** Worker backend `dsh`（本地 DeepSeek Harness `headless`）已接入；见 `examples/dsh.config.json` / `npm run demo:dsh`。

---

## 一句话结论

方向是 **持久化、事件驱动的 Agent Operating Runtime**，不是「多 Agent 拼盘」。  
下一步不要加更多 Agent/工具；先把 **Ticket / Assignment / Mandate / Outbox** 四对象的状态与不变量写清并测住。
