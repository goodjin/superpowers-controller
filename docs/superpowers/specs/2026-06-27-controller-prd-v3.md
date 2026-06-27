# Superpowers Controller PRD V3

## 1. Version

- Version: v3
- Date: 2026-06-27
- Status: current design source
- Supersedes:
  - `docs/superpowers/plans/2026-06-09-superpowers-controller-mvp.md`
  - `docs/superpowers/specs/2026-06-11-controller-final-design.md`
  - `docs/superpowers/plans/2026-06-11-controller-final-architecture-migration.md`

v1 是 MVP plan，重点是把 Superpowers 方法论接进 OpenCode 插件。v2 是 final design，确定了插件拥有 workflow state machine、模型只执行节点任务。v3 接收 v2 之后的运行时修正：工具面收敛、task-scoped 检查链、非阻塞派发、启动恢复、用户输入恢复、TUI progress surface 和 prompt artifact 内联。

## 2. Product Positioning

Superpowers Controller 是面向 coding agents 的 workflow control plugin。它借用 Superpowers methodology，但不是上游 Superpowers plugin，也不依赖 prompt 自律来维持流程。

插件负责状态、路由、门禁、会话创建、会话复用、恢复、取消、进度可见性和结果落盘。模型负责在被分配的 node session 里完成当前节点任务，并用结构化 `sp_report` 把结果交回 runtime。

核心边界：

```text
controller session
-> plugin prepares or resumes workflow state
-> plugin dispatches child node session
-> node agent executes one scoped task
-> node agent calls sp_report
-> plugin records state and computes next dispatch
```

模型不能决定下一个 node、不能自行创建 child session、不能在 report 里提交 `next_action`、不能用原生 task/question 绕过 controller。

## 3. Goals

- 让长任务、中断任务和多节点任务有可恢复的 workflow state。
- 把 public control surface 收敛成少量稳定工具，减少模型猜测。
- 把实现、验收、验证、代码审查拆成可追踪 node run。
- 在任务 graph 中只放结构化依赖，不从 markdown 反推 runtime 状态。
- 在插件重启、child session 中断、检查失败、用户输入等待时，让恢复动作可解释、可选择、可审计。
- 让用户在 TUI 里看到 workflow 和 child session 进展，但不把进度噪声写进模型上下文。

## 4. Non-Goals

- 不做通用 agent marketplace。
- 不把 `super-agent` 变成普通 coding agent。
- 不让节点 agent 调用原生 nested task 来继续分叉。
- 不提供独立 workflow question 面板；用户输入回到主会话处理。
- 不在 v3 中承诺完整 `parallel-investigate` 多 investigator 编排。当前实现是单 investigator + finish 汇总。
- 不把 durable `state.json` 中的旧 `running` 直接当成 live child session。

## 5. Public Tool Surface

v3 公开工具只有五个：

```text
sp_status -> sp_prepare -> sp_start -> sp_report -> transition
                    \-> sp_cancel
```

### 5.1 `sp_status`

只读查询当前 workflow、task、session、progress 和 incomplete history。返回内容要区分：

- `runtime`: runtime memory 中的当前事实。
- `durable`: `.opencode/superpowers/` 下的恢复和审计快照。
- `progress`: child session 事件日志。
- `live`: host API 可读时才代表 live session；不可读时标为 unavailable，不能用 durable running 冒充 live busy。

### 5.2 `sp_prepare`

准备一个 draft workflow，不派发节点会话。它写入 request、proposal、state，并等待用户确认。

支持：

- 新任务准备。
- 从 source workflow 复制 task graph 和 markdown artifacts。
- 创建 `activation: "draft"` 的 run。

不支持：

- 直接创建 child node session。
- 从自然语言重新拆已存在 workflow。
- 复制 source workflow 的 `node_runs`。旧 node history 仍属于旧 workflow。

### 5.3 `sp_start`

启动或恢复 workflow。

行为：

- 新 run: 按 workflow 和 entrypoint 派发入口 node。
- draft run: 激活后从已批准的 task graph 派发 runnable task。
- active run: 读取当前 state 后恢复，不从入口重开。
- `waiting_user`: 普通 `sp_start(run_id)` 只返回等待状态；`sp_start(run_id, resume_input)` 恢复原 child session。
- `recovered_unknown`: 普通 `sp_start(run_id)` 不自动派发；用户确认后用 `sp_start(run_id, task_id)` 为 interrupted task 创建新 attempt。

工具在 child prompt 被调度后返回，不等待 child model turn 完成。

### 5.4 `sp_report`

节点会话提交结构化结果。它是节点结果进入 runtime 的唯一入口。

核心字段：

```ts
type SpReportInput = {
  event:
    | "intake"
    | "question"
    | "design"
    | "plan"
    | "investigation"
    | "debug"
    | "red-test"
    | "implementation"
    | "acceptance"
    | "code-review"
    | "verification"
    | "finish"
  status: "progress" | "passed" | "failed" | "blocked" | "needs_user"
  summary: string
  artifacts?: Record<string, string>
  gates?: Record<string, boolean>
  checks?: string
  findings?: string
  question?: {
    prompt: string
    options?: Array<{ label: string; description?: string }>
  }
  task_graph?: TaskGraph
}
```

禁止字段：

```text
next_action
target_session_id
child_session_id
reuse_session_id
create_sessions
skills_used
```

`status: "progress"` 只更新 report、artifact、`reported_at` 和 progress history，不关闭 node，也不触发 downstream dispatch。只有 `passed`、`failed`、`blocked`、`needs_user` 会进入 transition。

`question.options` 的模型可见形状是 `{ label, description? }[]`。字符串数组只作为兼容旧调用的解析路径。

### 5.5 `sp_cancel`

取消 workflow、task 或 session。取消是显式状态变更。取消后 runtime 不自动补齐下一步，后续恢复必须重新读取 `node_runs` 和 workflow status。

## 6. Runtime State Model

workflow state 存在于 runtime memory，同时同步到 project-local durable snapshot：

```text
.opencode/superpowers/
  current.json
  runs/<run-id>/
    state.json
    request.md
    task.md
    proposal.md
    changelog.md
    task_graph.json
    artifacts/*.md
    reports/<task-id>/*.md
    nodes/<node-id>/
      task.md
      record.json
      output.md
      progress.jsonl
```

`WorkflowState` 的关键字段：

- `activation`: `draft` or `active`
- `workflow`: `feature`, `debug`, `plan-only`, `review`, `verify-finish`, `parallel-investigate`
- `entrypoint`: 用户确认的进入口径，例如 `feature`, `execute`, `review`
- `phase/current_phase`: 当前 runtime 阶段
- `status`: `intake`, `running`, `waiting_user`, `blocked`, `passed`, `failed`, `canceled`, `recovered_unknown`
- `task_graph`
- `node_runs`
- `pending_question`

runtime 判断优先读 `workflow`、`entrypoint`、`current_phase`、`status`、`task_graph` 和 `node_runs`。`mode`、`phase`、`session` 可以保留兼容用途，但不应覆盖新的 runtime 字段。

## 7. Node Runs

每次 dispatch 都要创建 `NodeRun`：

```ts
type NodeRun = {
  id: string
  task_id?: string
  phase: string
  agent: string
  primary_skill?: string
  session_id: string
  status: "running" | "passed" | "failed" | "blocked" | "needs_user" | "interrupted"
  attempts: number
  started_at: string
  reported_at?: string
  closed_at?: string
  ended_at?: string
  record_path?: string
}
```

登记顺序固定：

```text
create or reuse session
-> register node_runs
-> write task packet
-> schedule child prompt
```

这样 child session 即使很快调用 `sp_report`，runtime 也能找到对应 node。

node result 归属顺序：

1. 显式 node id。
2. child `sessionID`。
3. event phase + agent 的唯一 running match。
4. 单一 running node fallback。

多个 running node 无法唯一匹配时，runtime 拒绝猜测。

## 8. Agents And Skills

`super-agent` 是主会话控制器，不加载业务 skill，不执行节点工作。

| Agent | Role | Primary skill |
|---|---|---|
| `super-agent` | 用户意图、确认、恢复、调用 public tools | none |
| `sp-designer` | design/spec node | `superpowers-brainstorming` |
| `sp-planner` | plan and task graph node | `superpowers-writing-plans` |
| `sp-debugger` | root-cause debugging node | `superpowers-systematic-debugging` |
| `sp-investigator` | read-only investigation node | `superpowers-dispatching-parallel-agents` |
| `sp-implementer` | implementation/TDD node | `superpowers-test-driven-development` |
| `sp-acceptance-reviewer` | acceptance review node | `superpowers-requesting-code-review` |
| `sp-verifier` | fresh verification node | `superpowers-verification-before-completion` |
| `sp-code-reviewer` | code quality review node | `superpowers-requesting-code-review` |
| `sp-finisher` | final delivery node | `superpowers-finishing-a-development-branch` |

`sp-spec-reviewer` 是 v2 旧名，v3 不再使用。v3 的第一段 review 是 acceptance review，重点检查当前 task 是否满足用户确认的需求、spec、plan 和 acceptance criteria。

节点 agent 只加载一个 primary skill。需要其他 skill 时，由 controller 创建另一个节点会话。

## 9. Workflow Definitions

### 9.1 Feature

```text
intake
-> design
-> plan
-> implement runnable task graph
-> acceptance
-> verification
-> code-review
-> next runnable task or finish
```

规则：

- 新 `feature` run 从 design 开始。
- `entrypoint=execute` 且没有更具体 state 时，从 implementer 开始。
- implementation passed 后派发同一 `task_id` 的 acceptance。
- acceptance passed 后派发同一 `task_id` 的 verification。
- verification passed 后派发同一 `task_id` 的 code review。
- code-review passed 后重新计算 runnable task；没有后续 runnable task 且所有 task 达到 task-level passed 时派发 finish。

### 9.2 Debug

```text
intake
-> debug-root-cause
-> implement repair
-> acceptance
-> verification
-> code-review
-> finish
```

没有 root cause artifact 时，runtime 不允许进入 repair implementation。debug workflow 的 repair task 可以来自 prepare、plan 或后续 runtime 派发。

### 9.3 Plan-Only

```text
intake
-> plan
-> direct finish
```

用于只要计划、不执行实现的场景。planner 产出 plan 和 task graph 后，workflow 可以直接 passed，不派 implementer。

### 9.4 Review

```text
intake
-> acceptance
-> verification
-> code-review
-> optional implement retry
-> finish
```

review workflow 从 acceptance reviewer 开始。若检查失败，runtime 回派 implementer；修复后重新走检查链。

### 9.5 Verify-Finish

```text
intake
-> verification
-> optional implement retry
-> verification
-> code-review when policy requires
-> finish
```

fresh verification 失败时，runtime 优先复用可用 implementer session；没有可复用 session 时创建 retry implementer。

### 9.6 Parallel-Investigate

```text
intake
-> investigator
-> finish
```

当前 v3 按已实现范围记录：派发一个只读 investigator，收集 findings 后进入 finisher 汇总。v2 中的 independence-check、N investigator sessions 和 synthesis 是后续扩展方向，不是 v3 当前验收范围。

## 10. Task Graph

planner 或 source workflow 提供结构化 `TaskGraph`：

```ts
type TaskGraph = {
  tasks: Array<{
    id: string
    title: string
    summary: string
    depends_on: string[]
    files?: string[]
    test_commands?: string[]
    checks?: CheckState[]
  }>
}
```

runtime 规则：

- 拒绝未知 dependency。
- 对共享可写文件增加隐式依赖。
- 只派发依赖已满足、未 running、未 failed 的 task。
- implementation passed 不代表 task passed。
- task-level passed 需要 implementation、acceptance、verification、code-review 按 workflow policy 全部通过。
- failed、blocked、needs_user、interrupted node 会阻塞后续推进。

## 11. Dispatch And Prompt Contract

transition 输出只能是：

- `create_session`
- `reuse_session`
- `wait_user`
- `blocked`
- `finish`

session orchestrator 只执行 transition decision，不决定下一步。

node prompt 由 runtime 生成，必须包含：

- node id、run id、phase、agent、primary skill。
- task scope。
- required artifacts 的路径。
- required artifacts 的正文。
- `sp_report` contract。
- retry context 或 user resume context when applicable。

如果 required artifact 缺失，prompt 要显式标记 missing。node agent 不需要也不应该全盘搜索 workflow artifacts。

## 12. User Input

节点需要用户输入时调用：

```ts
sp_report({
  event: "question",
  status: "needs_user",
  summary: "...",
  question: {
    prompt: "...",
    options: [{ label: "...", description: "..." }]
  }
})
```

runtime 行为：

1. 写入 `pending_question`。
2. workflow 进入 `waiting_user`。
3. 停止派发后续 node。
4. 调度 parent controller session prompt。
5. `super-agent` 在主会话询问用户。
6. 用户回答后，`super-agent` 调用 `sp_start(run_id, resume_input)`。
7. runtime 校验 `source_node_id`，清空 `pending_question`，恢复原 child session。

没有独立 workflow question route。TUI 可以显示 pending question，但不收集答案。

## 13. Recovery

### 13.1 Runtime Memory And Durable Snapshot

runtime memory 是当前 workflow 状态权威。durable files 用于重启恢复、审计和 TUI 降级读取。

### 13.2 Startup Reconciliation

插件进程启动时，旧 `node_runs[].status === "running"` 不能直接当作 live child turn。恢复规则：

- running node 变成 `interrupted`。
- active running workflow 变成 `recovered_unknown`。
- draft workflow 不受影响。
- 不自动派发 replacement work。
- 用户确认后才能 retry 或 cancel。

### 13.3 Resume Priority

恢复时按顺序判断：

1. `waiting_user`: 需要 `resume_input`。
2. `recovered_unknown`: 需要用户确认 retry/cancel/inspect。
3. running node: 等待或取消，不重复派发。
4. failed/blocked/interrupted node: 走 retry 或用户决策。
5. runnable task graph: 派发 implementer。
6. all task-level passed: 派发 finish。
7. no task graph and initial phase: 才回到 workflow entrypoint。

这个顺序防止已经跑到后半段的 workflow 被入口字段拉回 design 或 plan。

## 14. Progress And TUI

progress 是 side-channel。它帮助用户看见运行状态，不参与 gate、transition 或 task graph 调度。

progress 来源：

- `ProgressUpdate.stage`: dispatch、node recorded、waiting user、blocked、finished 等 UI/log 事件。
- `nodes/<node-id>/progress.jsonl`: OpenCode child session text/tool/patch/status/error 事件。
- `sp_report.status = "progress"`: 节点中间汇报，不关闭 node。

TUI surfaces：

- `superpowers-progress` route: 完整 workflow 和 node progress 面板。
- `superpowers.progress` command: 打开 progress route。
- `app_bottom`: 主会话底部整体状态。
- `sidebar_content`: workflow 会话运行信息主 surface，显示 parent/child session 相关 workflow、running nodes、latest activity、pending question。
- `sidebar_footer`: 简短状态 fallback。

不注册：

- `session_prompt_right`
- `home_prompt`
- `home_prompt_right`
- `home_bottom`
- `home_footer`
- `superpowers-questions`

TUI resolver 不扫描用户磁盘，只读取 host 当前目录和显式配置的 workflow project。没有找到 workflow 时，显示清楚诊断；不要静默空白。

## 15. Gates

关键 gate：

- `request_confirmed`
- `design_approved`
- `spec_written`
- `plan_written`
- `root_cause_found`
- `red_test_seen`
- `implementation_done`
- `acceptance_passed`
- `verification_fresh`
- `code_review_passed`

artifact-backed gate 需要对应 artifact。单个 report 更新过多 gate 应被拒绝，避免模型一次性把整个 workflow 口头标绿。

finish 对 feature/debug/review/verify-finish 至少要求 fresh verification。带 task graph 的 workflow 还要求所有 task 达到 task-level passed。

## 16. Persistence And Audit

每次重要状态变化要写入：

- `state.json`
- `changelog.md`
- `events.jsonl`
- node `record.json`
- node `output.md`
- task report markdown

`node_runs` 是执行事实来源。重试不能覆盖旧 node run；应追加 attempt 或新 node id。

## 17. Permissions

`super-agent`：

- 不加载 business/development skills。
- 禁用 native task。
- 不直接编辑代码。
- 可以做用户澄清和 controller-level question。

node agents：

- 只允许 router 分配的 primary skill。
- 禁用 native task。
- 禁用 native question。
- reviewer/verifier/investigator 默认不编辑文件。
- 需要用户输入时只能通过 `sp_report(status="needs_user")`。

当 OpenCode global permission 是 `allow` 时，插件可以继承 read/edit/bash 等姿态，但 native task 和 node native question 仍保持 controller 边界。

## 18. Testing And Acceptance

v3 要求测试覆盖：

- public tools 只暴露五个。
- `sp_prepare` 创建 draft，不派发 node。
- `sp_start` 激活 draft 并派发 runnable task。
- `sp_start(run_id)` 不从入口重开 active run。
- `sp_start(run_id, resume_input)` 恢复 waiting child。
- `sp_report(status="progress")` 不触发 dispatch。
- failed acceptance/verification/code-review 回派 implementer。
- task-level passed 必须包含实现和检查链。
- startup reconciliation 把旧 running 转成 interrupted/recovered_unknown。
- nonblocking dispatch/resume/notify 不等待 child prompt 完成。
- artifact 正文被内联到 node prompt。
- TUI progress route、slots、fallback project resolver、stalled wording 和 pending question display。
- package build 和 OpenCode isolated runtime smoke/e2e。

常用验证命令：

```bash
bun run test
bun run build
bun run test:e2e:opencode
```

## 19. Migration Notes From V2

v3 替换以下 v2 口径：

| V2 term | V3 term |
|---|---|
| `sp_record` | `sp_report` |
| `sp-spec-reviewer` | `sp-acceptance-reviewer` |
| `spec-review -> code-review -> verify` | `acceptance -> verification -> code-review` |
| `sp_route` / `sp_next` / `sp_reset` public loop | `sp_status` / `sp_prepare` / `sp_start` / `sp_cancel` / `sp_report` |
| child native question or TUI question route | `sp_report(needs_user)` + parent controller prompt + `sp_start(resume_input)` |
| prompt lists artifact paths only | runtime inlines required artifact bodies |
| durable running implies live running | startup reconciliation marks old running as interrupted |

历史文档仍可用于追溯，但当前实现、测试和后续设计应以 v3 PRD、`docs/modules/*` 和 runtime source 为准。

