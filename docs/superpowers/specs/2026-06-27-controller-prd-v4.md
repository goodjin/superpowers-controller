# Superpowers Controller PRD V4

## 1. Version

- Version: v4
- Date: 2026-06-27
- Status: implementation-ready PRD draft
- Supersedes:
  - `docs/superpowers/specs/2026-06-27-controller-prd-v3.md`
  - `docs/superpowers/specs/2026-06-11-controller-final-design.md`
  - `docs/superpowers/plans/2026-06-09-superpowers-controller-mvp.md`

v4 继承 v3 的 public tool loop、agent 边界、task-scoped 检查链、runtime memory 优先、非阻塞派发、启动恢复、用户输入恢复和 TUI progress surface。

v4 的新增重点有两类：第一类是异常路径闭合，第二类是准备阶段前移。controller intake 要先把用户侧问题问清楚；`sp_prepare` 可以派发 design draft；`sp_start` 批准 design 后进入 plan，再批准 plan 后进入 implementation。

任何未结束 workflow 都要能回答四个问题：

1. 当前事实是什么。
2. 是否有 live node 正在运行。
3. 如果没有 live node，下一步是等待用户、重试、取消、阻塞还是结束。
4. 这个判断在哪里落盘，用户在哪里能看到。

## 2. Product Positioning

Superpowers Controller 是面向 coding agents 的 workflow control plugin。插件拥有 workflow state machine、节点派发、恢复、取消、用户输入路由、进度可见性和结果落盘。

模型只在被分配的 node session 里执行当前 scoped task，并通过 `sp_report` 提交结构化结果。模型不能自己决定下一个 node，不能通过 native task 或 native question 绕过 controller。

核心循环保持五个 public tool 不变，但 feature 的准备阶段前移：

```text
controller intake
-> sp_prepare
-> design draft node
-> sp_start approves design
-> plan draft node
-> sp_start approves plan
-> implementation/check/finish nodes
-> sp_report transitions
```

工具面仍然是：

```text
sp_status -> sp_prepare -> sp_start -> sp_report -> transition
                         \-> sp_cancel
```

## 3. V4 Goals

- 让所有非终态 workflow 都有明确的 next decision，避免空转、卡住和静默跑偏。
- 补齐 draft preparation、用户等待、取消、派发失败、通知失败、stale state 返回和缺失 task graph 的设计约束。
- 把 feature 类工作拆成 design approval 和 plan approval 两个准备门禁，减少 implementation 已启动后再回头问需求的问题。
- 要求 controller intake 在 `sp_prepare` 前尽量问清用户侧问题；designer 只在设计阻塞时回问。
- 允许 controller 在任何状态下按原则自主决策，但插件必须给出足够清楚的状态反馈和可执行下一步。
- 把异常场景写成状态机规则和验收场景，后续实现时可以直接落到测试。
- 保持 public tool surface 稳定，不通过增加工具掩盖状态机问题。
- 保持 progress side-channel 定位。progress 可以提升可见性，不能驱动 transition，也不能清除 gate 或 pending question。

## 4. Non-Goals

- 不在 v4 中新增 public tool。
- 不在 v4 中实现完整多 investigator 的 `parallel-investigate`。当前仍按单 investigator + finish 汇总记录。
- 不用程序硬拒绝 designer 的所有用户问题。designer 问题边界主要通过 prompt contract 引导模型判断，runtime 只负责记录、路由和反馈。
- 不把 controller 变成 implementation agent。controller 可以判断流程和做低风险决策，但不直接执行节点工作。
- 不把 durable `running` 当成 live busy。
- 不让 node agent 使用 native task 或 native question。
- 不在本 PRD 中描述具体代码改动；实现计划和代码变更另行立项。

## 5. Public Tool Surface

v4 公开工具仍为五个：

```text
sp_status
sp_prepare
sp_start
sp_cancel
sp_report
```

### 5.0 Controller Intake

controller intake 发生在 `sp_prepare` 之前。它的目标是把用户侧问题问清楚，而不是设计技术方案。

controller 应先确认：

- 用户要完成的具体结果。
- 需求范围和不做什么。
- 是否允许修改代码、文档、测试、配置、构建脚本。
- 是否有用户偏好的交互、兼容性、数据、安全、性能或发布约束。
- 是否存在用户必须亲自决定的产品取舍。
- 当前请求是新 workflow、继续已有 workflow，还是只做 review/verify/debug。

controller 不应在 intake 阶段替 designer 做系统设计，也不应替 planner 拆 task graph。controller 可以根据仓库惯例和用户上下文做低风险默认判断；如果判断会改变用户目标、产品行为、数据安全或外部副作用，应先问用户。

### 5.1 `sp_status`

`sp_status` 是只读事实查询。它必须区分：

- `runtime`: runtime memory 中的当前事实。
- `durable`: `.opencode/superpowers/` 下的恢复和审计快照。
- `live`: host API 可确认的 child session 运行状态。
- `progress`: UI/log 可见性事件。
- `recommended_next`: controller 根据当前 state 算出的下一步建议。

`recommended_next` 不能只写自由文本。它至少要能表达：

```ts
type RecommendedNext =
  | { action: "wait_running_node"; node_id: string; session_id: string }
  | { action: "answer_pending_question"; run_id: string; node_id: string }
  | { action: "approve_design"; run_id: string }
  | { action: "revise_design"; run_id: string }
  | { action: "retry_dispatch"; run_id: string; node_id: string }
  | { action: "retry_node"; run_id: string; task_id?: string; phase: string }
  | { action: "cancel_node"; run_id: string; node_id: string }
  | { action: "cancel_workflow"; run_id: string }
  | { action: "approve_plan"; run_id: string }
  | { action: "revise_plan"; run_id: string }
  | { action: "finish"; run_id: string }
  | { action: "blocked"; reason: string };
```

### 5.2 `sp_prepare`

`sp_prepare` 用于把用户请求整理成可确认的 workflow draft。v4 支持三种模式，返回值必须说明当前模式：

```ts
type PrepareMode = "proposal_only" | "managed_design" | "managed_planning";
```

#### Proposal-only

适合轻量任务和用户还没有确认执行范围的场景。

行为：

- 写入 request、proposal、draft state。
- 不派发 child node。
- 返回 `activation: "draft"` 和 `prepare_mode: "proposal_only"`。
- `sp_start(run_id)` 只能激活入口节点，不能假装已有 design 或 task graph。

#### Managed design

适合 feature、复杂 bugfix、较大 refactor 和需要技术方案约束的场景。

行为：

- 创建 `activation: "draft"` 的 run。
- 派发 designer node，但 designer 只能产出 design/spec、constraints、acceptance criteria 和风险说明。
- designer passed 后 workflow 进入 `awaiting_design_approval`。
- 用户批准后调用 `sp_start(run_id)`，runtime 派发 planner node。
- 用户要求修改时，controller 派发 design revision，不进入 planning 或 implementation。

designer 可以调用 `sp_report(status="needs_user")`，但 prompt contract 要明确：只允许询问设计阻塞问题。常规用户侧问题应由 controller intake 在 `sp_prepare` 前处理。

#### Managed planning

适合 plan-only、已有 design/spec 的 source workflow、用户明确只要计划拆分的场景。

行为：

- 创建 `activation: "draft"` 的 run。
- 派发 planner node，但 planner 只能产出 plan、acceptance criteria 和 `task_graph`。
- planner passed 后 workflow 进入 `awaiting_plan_approval`。
- 用户批准后调用 `sp_start(run_id)` 激活 approved plan。
- 用户要求修改时，controller 派发 plan revision，不进入 implementation。

v4 要求 `sp_prepare` 不再产生“看起来已准备好执行，但没有 design、没有 task graph、也没有 draft node 正在运行”的 draft。

### 5.3 `sp_start`

`sp_start` 启动、批准、恢复或重试 workflow。v4 要求返回派发后的 fresh state，即 `store.readCurrent()` 或等价的新快照。

行为规则：

- `draft + proposal_only`: 激活 entrypoint，按入口派发第一个节点。
- `draft + awaiting_design_approval`: 用户批准后派发 planner，workflow 仍处于 draft preparation，不进入 implementation。
- `draft + awaiting_plan_approval`: 用户批准后激活 task graph，派发第一个 runnable implementation task。
- `active + waiting_user + no resume_input`: 返回 waiting 状态，不清空 `pending_question`。
- `active + waiting_user + resume_input`: 校验 `source_node_id` 后恢复原 child session。
- `active + recovered_unknown`: 不自动 retry，返回 inspect/retry/cancel 建议。
- `active + dispatch_failed`: 支持 retry dispatch 或 cancel。
- `active + blocked/interrupted`: 按状态决策表给出 retry/cancel/blocked。
- `active + running live node`: 返回 wait，不重复派发。

### 5.4 `sp_report`

`sp_report` 是 node result 进入 runtime 的唯一入口。

`status: "progress"` 的 v4 约束：

- 只写 progress history、report summary、artifact draft 和 `reported_at`。
- 不关闭 node。
- 不触发 downstream dispatch。
- 不修改 workflow terminal status。
- 不清空 `pending_question`。
- 如果 workflow 已经是 `waiting_user`，progress 不得把 workflow 改回 `running`。

终态或门禁状态仍为：

```text
passed
failed
blocked
needs_user
```

`needs_user` 必须携带 `question.prompt`，并写入 `pending_question`。只有用户回答路径可以清空它。

### 5.5 `sp_cancel`

`sp_cancel` 可以取消 workflow、task 或 session。v4 要求取消后的 workflow 必须有可见 next decision：

- 取消整个 workflow: workflow 进入 `canceled`。
- 取消单个 running node: node 进入 `canceled`，workflow 根据 task graph 和 phase 进入 `blocked` 或 `waiting_user_decision`。
- 取消 check node: 可以建议 retry check、retry implementer、cancel workflow。
- 取消 implement node: 不允许 workflow 继续保持无 live node 的 `running`。

## 6. Runtime State Model

v4 保留 v3 的 runtime memory 优先原则。durable files 用于恢复、审计和 TUI 降级读取。

新增或收紧的状态字段：

```ts
type WorkflowStatus =
  | "intake"
  | "running"
  | "awaiting_design_approval"
  | "awaiting_plan_approval"
  | "waiting_user"
  | "waiting_user_decision"
  | "blocked"
  | "passed"
  | "failed"
  | "canceled"
  | "recovered_unknown";

type NodeRunStatus =
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "needs_user"
  | "interrupted"
  | "dispatch_failed"
  | "notification_failed"
  | "canceled";
```

`waiting_user_decision` 用于 workflow 需要用户选择 retry、cancel、approve 或 revise，但不是 node 提出的业务问题。

`dispatch_failed` 表示 child session 已注册或准备注册，但 prompt scheduling 没有成功完成。它不能长期伪装成 `running`。

`notification_failed` 表示 node 已经进入 `needs_user`，但 parent controller prompt 通知失败。workflow 仍是 `waiting_user`，TUI 和 `sp_status` 必须显示 pending question。

## 7. State Invariants

v4 要求 runtime 持续满足以下不变量：

### 7.1 Non-Terminal Closure

任何未结束 workflow 都必须满足至少一个条件：

- 有 host API 可确认的 live running node。
- 有 `pending_question` 等待用户回答。
- 有 `awaiting_design_approval` 等待用户批准或修改设计。
- 有 `awaiting_plan_approval` 等待用户批准或修改计划。
- 有 `recommended_next` 指向 retry、cancel、finish 或 blocked reason。
- 有明确的 terminal transition 正在落盘。

如果以上都不成立，workflow 必须进入 `blocked`，并写明 `blocked_reason`。

### 7.2 Waiting User Preservation

`pending_question` 是用户等待状态的事实来源。以下事件不得清空它：

- `sp_report(status="progress")`
- TUI refresh
- startup reconciliation
- parent notification retry
- `sp_start(run_id)` without `resume_input`

只有 `sp_start(run_id, resume_input)` 在校验来源 node 后可以清空 `pending_question`。

### 7.3 Dispatch Failure Visibility

后台 prompt scheduling 失败时，runtime 必须：

- 记录 node status 为 `dispatch_failed`。
- 写入 `events.jsonl` 和 node `record.json`。
- workflow 进入 `blocked` 或 `waiting_user_decision`。
- `sp_status` 返回 `recommended_next: retry_dispatch | cancel_node | cancel_workflow`。
- TUI 显示失败节点、失败原因和可选操作。

### 7.4 Fresh Return State

任何会改变 state 的工具调用，返回给调用方的 state 必须反映本次变更后的事实。

`sp_start` 在派发后不能返回派发前的 stale state。返回值至少要包含新 `node_runs`、workflow status、current phase 和 recommended next。

### 7.5 Task Graph Guard

feature/debug/review/verify-finish 进入 implementation 前，必须有 task scope。

允许的 task scope 来源：

- approved `task_graph` 中的 runnable task。
- debug root cause 产生的 repair task。
- 用户显式选择 single-task execution。

如果 plan passed 但没有 `task_graph`，runtime 不能默认派发 generic implementer。它应进入 `waiting_user_decision` 或 `blocked`，要求补 plan、转 single-task 或取消。

### 7.6 Designer Question Boundary

designer 的提问边界通过 prompt contract 引导，不作为 runtime 硬拒绝规则。

designer 可以问用户的问题必须满足至少一个条件：

- 产品行为存在冲突，无法从用户原始需求推出合理默认值。
- 设计方案涉及明显的安全、权限、数据保留、兼容性或外部副作用。
- 有多个设计方向，成本、风险或用户体验差异明显。
- 需要用户选择业务策略，而不是代码实现细节。

designer 不应把以下问题推给用户：

- 是否要写测试、更新文档、跑构建。
- 是否遵循仓库已有代码风格。
- 是否按已有模块边界实现。
- 普通技术细节、命名、文件组织、内部 helper 选择。
- controller intake 本应确认的范围问题。

如果 designer 仍然提出非阻塞问题，controller 可以按自主决策原则给出默认答案并恢复 node；也可以把问题改写成更窄的用户确认问题。

### 7.7 Prompt Contract, Not Hard Enforcement

v4 承认运行时仍依赖大模型推理。插件负责提供状态、边界、可选动作和结果记录；模型负责在提示词约束下判断当前问题是否需要用户参与。

因此，designer question boundary、controller autonomy 和 intake quality 主要通过以下方式实现：

- controller prompt 的原则和场景清单。
- designer prompt 中的允许提问/不应提问规则。
- `sp_status` 和工具返回值中的 `controller_feedback`。
- 验收测试检查 prompt 内容、状态流转和异常反馈，不要求 runtime 对每一种语义问题做硬分类。

## 8. Controller Autonomy And Plugin Feedback

controller 在任何状态下都可以自主判断下一步。这个自主权服务于一个目标：在不越过用户意图和安全边界的前提下，把用户任务推进到可验证完成。

### 8.1 Autonomy Principles

controller 决策遵循以下优先级：

1. 用户明确指令优先。
2. 当前 workflow state 和 plugin feedback 优先于 durable 旧快照。
3. 不把用户必须决定的产品、数据、安全、权限、费用、外部副作用问题替用户决定。
4. 对低风险、可逆、符合仓库惯例的实现细节，可以自主选择并继续推进。
5. 对 runtime 异常、dispatch failure、notification failure，可以优先 retry 或查询 `sp_status`；连续失败后再请求用户或进入 blocked。
6. 对 node 提出的模糊问题，先判断是否已有用户上下文可回答；能安全回答就恢复 node，不能安全回答再问用户。
7. 不通过 native task/native question 绕过 controller。
8. 每次自主决策都应能在日志、工具返回或最终摘要里解释。

### 8.2 Decision Scenarios

| Scenario | Controller can decide | Controller should ask user |
|---|---|---|
| 代码风格、文件位置、helper 命名 | 按现有仓库惯例选择 | 用户指定了不同风格 |
| 是否补测试、跑构建、更新模块文档 | 按项目规则执行 | 用户明确要求跳过 |
| designer 问普通实现细节 | 选择低风险默认值并 resume | 选择会改变产品行为 |
| planner 缺 task graph | 要求 planner revise 或转 blocked | 用户是否接受 single-task execution |
| dispatch/notification 暂时失败 | retry 一次或查询 status | 多次失败或可能重复执行 |
| recovered_unknown | inspect/status 后给 retry/cancel 建议 | 是否重跑可能产生副作用的节点 |
| cancel 单个 node 后 workflow 未结束 | 给出 retry/cancel/choose-task 建议 | 是否放弃整个 workflow |
| 用户新增无关请求 | 判断是否新 workflow | 同一任务和新任务边界不清 |

### 8.3 Controller Feedback Contract

插件控制运行，因此每个 public tool 都要让 controller 知道“现在能做什么”。所有工具返回值应包含 `controller_feedback` 或等价结构：

```ts
type ControllerFeedback = {
  outcome: "ok" | "waiting" | "needs_user" | "needs_approval" | "blocked" | "failed" | "terminal"
  state_version: string
  run_id?: string
  current_status: WorkflowStatus
  current_phase: string
  recommended_next: RecommendedNext[]
  allowed_tool_calls: Array<"sp_status" | "sp_prepare" | "sp_start" | "sp_cancel" | "sp_report">
  requires_user?: {
    reason: string
    question?: string
    options?: Array<{ label: string; description?: string }>
  }
  approval_target?: "design" | "plan" | "retry" | "cancel"
  autonomous_options?: Array<{
    action: string
    when_safe: string
    risk: "low" | "medium" | "high"
  }>
  blocking_reason?: string
}
```

要求：

- `sp_status` 必须能在任何时候给出当前事实和下一步建议。
- `sp_prepare` 必须说明是否已派发 draft node，或为什么没有派发。
- `sp_start` 必须说明本次是批准 design、批准 plan、恢复用户输入、retry，还是普通启动。
- `sp_cancel` 必须说明取消后的 workflow 是否 terminal，若非 terminal，下一步是什么。
- `sp_report` 的 transition 结果必须能让 controller 判断是否继续、等待、问用户、批准、重试或结束。

如果插件无法满足 controller 的请求，不能静默返回空结果。它应返回 structured feedback：原因、当前事实、允许的下一步和是否需要用户介入。

### 8.4 Controller Satisfaction Loop

controller 可以在任何混乱状态下调用 `sp_status` 重新对齐事实。插件需要支持这个循环：

```text
controller unsure
-> sp_status
-> controller_feedback
-> controller chooses ask user / approve / retry / cancel / wait / continue
-> tool call
-> fresh state + controller_feedback
```

这个机制保证插件控制运行时不会让 controller 失去上下文。controller 不需要猜 durable files，不需要从 progress 文本反推状态，也不需要自行创造下一步。

## 9. State Decision Table

| Current fact | Workflow status | Node status | Decision |
|---|---|---|---|
| host confirms child still running | `running` | `running` | `wait_running_node` |
| durable says running but host cannot confirm after restart | `recovered_unknown` | `interrupted` | `retry_node` or `cancel_node` after user decision |
| node asks business question | `waiting_user` | `needs_user` | `answer_pending_question` |
| parent notification failed | `waiting_user` | `notification_failed` | show pending question, retry notify or answer through controller |
| child prompt scheduling failed | `blocked` or `waiting_user_decision` | `dispatch_failed` | `retry_dispatch` or cancel |
| design passed | `awaiting_design_approval` | `passed` | approve or revise design |
| implement node canceled | `waiting_user_decision` | `canceled` | retry implement, choose another task, or cancel workflow |
| check node failed | `running` or `blocked` | `failed` | dispatch retry implementer when policy allows |
| non-check node failed | `blocked` | `failed` | retry same phase or cancel |
| node blocked without user question | `blocked` | `blocked` | retry same node, revise scope, or cancel |
| plan passed with task graph | `awaiting_plan_approval` | `passed` | approve or revise plan |
| plan passed without task graph | `waiting_user_decision` or `blocked` | `passed` | require graph, single-task confirmation, or cancel |
| all task-level gates passed | `running` | latest passed | dispatch finish |
| finish passed | `passed` | `passed` | terminal |
| workflow canceled | `canceled` | any | terminal |

调度器不能对未结束 workflow 返回空 dispatch list，除非当前决策已经明确是 `wait_running_node`、`answer_pending_question`、`approve_design`、`approve_plan`、`blocked` 或 terminal。

## 10. Workflow Updates

### 10.1 Feature

推荐的 managed design flow：

```text
controller intake
-> sp_prepare(managed_design)
-> designer draft node
-> awaiting_design_approval
-> sp_start(run_id) after design approval
-> planner draft node
-> awaiting_plan_approval
-> sp_start(run_id) after plan approval
-> implement runnable task
-> acceptance
-> verification
-> code-review
-> next runnable task or finish
```

除非用户明确转成 single-task execution，否则 feature workflow 不能从缺少 task graph 的 plan 进入 implementation。

### 10.2 Debug

debug workflow 在 repair implementation 前需要先有 root cause：

```text
debug-root-cause
-> repair task
-> implement
-> acceptance
-> verification
-> code-review
-> finish
```

如果 root cause 节点 blocked、canceled 或 interrupted，controller 应询问 retry/cancel，而不是直接派发 repair。

### 10.3 Plan-Only

plan-only flow 可以在 approved plan 后结束：

```text
controller intake
-> sp_prepare(managed_planning)
-> planner
-> awaiting_plan_approval
-> finish or passed
```

如果 plan-only planner 没有返回 plan artifact，workflow 进入 `blocked`。

### 10.4 Review And Verify-Finish

review 和 verify-finish 可以把 failed check 回派给 implementer，但前提是存在 scoped repair task。如果没有 task scope，controller 应请求用户决策，或带原因进入 blocked。

### 10.5 Parallel-Investigate

v4 当前范围保持为：

```text
investigator
-> finish
```

名称可以为兼容性保留，但 status 输出不能暗示已派发多个 investigator，除非 runtime 确实创建了多个 investigator session。

## 11. User Input And Notification

当 node 需要用户输入时：

1. `sp_report(status="needs_user")` 写入 node result。
2. runtime 写入 `pending_question`。
3. workflow status 变成 `waiting_user`。
4. controller 调度 parent prompt。
5. TUI、`sp_status` 和 `controller_feedback` 立即显示 pending question。
6. 用户回答后，通过 `sp_start(run_id, resume_input)` 恢复。

如果第 4 步失败：

- 不清空 `pending_question`。
- 将 node 标成 `notification_failed`，或把 notification error 写入 node record。
- 保持 workflow `waiting_user`。
- 通过 `sp_status`、TUI 和 `controller_feedback` 暴露 pending question。
- 允许 notification retry、controller 直接收集答案，或取消 workflow。

## 12. Recovery And Reconciliation

Startup reconciliation keeps the v3 rule:

- durable `running` does not imply live child session.
- unknown old running nodes become `interrupted`.
- active running workflow 变成 `recovered_unknown`。
- draft workflow remains draft.
- runtime does not auto-dispatch replacement work.

v4 adds a follow-up requirement: after reconciliation, `sp_status` must compute a concrete `recommended_next`. A recovered workflow cannot appear as a generic current run with no action.

## 13. Persistence And Audit

会改变 state 的事件需要更新：

- `state.json`
- `events.jsonl`
- `changelog.md`
- node `record.json`
- node `progress.jsonl`，如适用
- task report markdown，如适用

异常状态记录需要包含：

- failure kind: dispatch、notification、cancellation、interruption、blocked、missing artifact、missing task graph。
- affected `run_id`、`node_id`、`session_id`、`task_id`，如可得。
- recommended next action。
- action 是自动动作还是需要用户确认。

## 14. TUI And Progress Requirements

TUI surfaces 保持：

- `superpowers-progress` route.
- `superpowers.progress` command.
- `app_bottom`.
- `sidebar_content`.
- `sidebar_footer` fallback.

v4 要求异常状态在 `sidebar_content` 中可见：

- pending question。
- design awaiting approval。
- plan awaiting approval。
- dispatch failed。
- notification failed。
- recovered unknown。
- canceled node with workflow still open。
- blocked because task graph is missing。

progress events 可以描述这些状态，但不能驱动 transition。

## 15. Acceptance Scenarios

v4 实现需要通过以下场景后再验收：

1. controller intake 在 `sp_prepare` 前确认用户侧目标、范围、约束和必要取舍。
2. `sp_prepare(managed_design)` 创建 draft run，派发 designer，designer passed 后进入 `awaiting_design_approval`。
3. 批准 `awaiting_design_approval` run 时，`sp_start(run_id)` 派发 planner，并返回包含新 node run 的 fresh state。
4. designer prompt 明确说明只允许询问设计阻塞问题；非阻塞实现细节由 designer 或 controller 自主处理。
5. `sp_prepare(managed_planning)` 创建 draft run，派发 planner；planner 带 task graph passed 后进入 `awaiting_plan_approval`。
6. 批准 `awaiting_plan_approval` run 时，`sp_start(run_id)` 派发第一个 runnable task，并返回包含新 node run 的 fresh state。
7. planner passed without task graph 不为 feature workflow 派发 generic implementer；它请求补 graph、single-task confirmation 或 cancellation。
8. 每个 public tool 返回 fresh state 和 `controller_feedback`，controller 能从中判断 ask user、approve、retry、cancel、wait、continue 或 terminal。
9. canceling a running implement node 不会让 workflow 停在无 live node、无 next decision 的 `running`。
10. workflow 处于 `waiting_user` 时，`sp_report(status="progress")` 保留 `pending_question`，且不把 workflow 改回 `running`。
11. child prompt scheduling failure 记录 `dispatch_failed`，把 workflow 移入可恢复状态，并通过 `sp_status` 暴露 retry/cancel。
12. parent notification failure 通过 `sp_status`、TUI 和 `controller_feedback` 保持 `pending_question` 可见。
13. `sp_start` 派发后返回 fresh state，而不是派发前捕获的旧 state。
14. startup recovery 把 stale durable running nodes 转成 `interrupted`，并返回 retry/cancel/inspect 建议。
15. `decideNextDispatches` or equivalent dispatcher never returns `[]` for an unfinished workflow unless `recommended_next` explains wait, user input, approval, blocked or terminal state.
16. review/verify-finish failure 只有在存在 scoped repair task 时才回派 implementer。
17. parallel-investigate status 准确报告实际派发的 investigator session 数量。

## 16. Migration Notes From V3

| V3 risk | V4 decision |
|---|---|
| `sp_prepare` creates draft but may not create executable plan | introduce `proposal_only`、`managed_design` 和 `managed_planning` |
| design asks user questions after start | move feature design into `sp_prepare(managed_design)`，并增加 designer question boundary |
| controller lacks runtime feedback | add `controller_feedback` to public tool outputs |
| controller autonomy is underspecified | add autonomy principles and decision scenarios |
| canceled implement node can leave workflow silently stuck | canceled nonterminal node forces retry/cancel/user-decision state |
| progress can accidentally override waiting user | progress cannot clear `pending_question` or move `waiting_user` to `running` |
| background prompt failure leaves stale running | record `dispatch_failed` and expose retry/cancel |
| parent notification failure is not user-visible enough | keep waiting state and expose pending question in status/TUI |
| `sp_start` may return stale state | return fresh post-dispatch state |
| plan without task graph can run generic implementer | require task scope or user confirmation |
| incomplete workflow can have no dispatches | add non-terminal closure invariant and decision table |

当前实现和测试可能仍停留在 v3 行为。v4 是下一轮实现的目标 PRD。
