# Runtime Workflow 工具体系契约

## 背景

Superpowers Controller 需要更小的工具面和更清楚的运行时契约。主控会话不读文件、不改代码、不跑命令，也不直接创建原生子会话。它只负责查看状态、准备任务、启动或恢复任务、取消任务。真正的工作由插件创建的节点会话执行，节点会话完成后通过结构化结果汇报给插件。

这次设计把工具收敛成 5 个动作：

- `sp_status`
- `sp_prepare`
- `sp_start`
- `sp_cancel`
- `sp_report`

插件负责 workflow 状态、会话创建、调度、重试、关闭、文件持久化和状态转换。模型只通过这些工具表达用户侧动作。

## 目标

- `super-agent` 只保留 controller 工具。
- 所有执行工作都放进插件创建的 workflow session。
- 当前状态以 runtime memory 为准。
- 文件只作为快照、日志、报告和恢复材料。
- 每个生成的 session prompt 都保存为 markdown，方便审计。
- 用同一套 task/session/report 模型支持编程工作流和非编程工作流。
- 使用 `sp-acceptance-reviewer` 表示实现结果的验收检查。

## 设计约束

- 工具集只包含 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- 下一步判断由 runtime 执行，不作为模型可调用动作。
- 路由和 proposal 由 `sp_prepare` 处理。
- 用户侧放弃任务统一走 `sp_cancel`。
- 不创建 per-task history 文件。历史统一写入 `events.jsonl`。
- 不要求每个任务都有编程检查。

## 工具面

### `sp_status`

用途：查询 workflow、task、session 和 report 状态。

输入：

```ts
{
  workflow_id?: string
  task_id?: string
  include_history?: boolean
}
```

逻辑：

- 如果 runtime memory 里有 active workflow，优先返回内存中的实时状态。
- 如果 runtime memory 里没有 active workflow，扫描 `.opencode/superpowers/workflows/`，返回未完成的 workflow 候选。
- 如果指定的 workflow 只存在于磁盘，返回 `recovered_unknown` 或 `needs_resume_decision`；文件里旧的 `running` 不代表当前仍在运行。
- 如果传入 `task_id`，返回该 task、最新报告、检查状态、当前或可复用 session，以及 `sp_start` 是否可以运行它。
- 这是只读工具。

文件访问：

- 需要恢复上下文时读取 `workflow.json`、`tasks.json`、`sessions.json`、`events.jsonl` 和 report markdown。
- 不写文件。

### `sp_prepare`

用途：从已确认的用户任务准备 workflow，或载入一个选中的历史 workflow 做继续前检查。

输入：

```ts
{
  task?: string
  workflow_id?: string
  source_workflow_id?: string
  kind?: "feature" | "debug" | "plan-only" | "review" | "verify-finish" | "parallel-investigate"
}
```

逻辑：

- 新任务：在 runtime memory 中创建 prepared workflow。
- 已有 `workflow_id`：把该 workflow 载入 runtime memory，并返回可继续的选项。
- 传入 `source_workflow_id`：读取已完成 workflow 的 result、`plan.md`、`tasks.json` 或 reports，生成新 workflow 的输入来源。
- workflow 类型和 proposal 由 `sp_prepare` 内部处理。
- 如果确认后的任务仍不清楚，返回 `requires_user_input`，不启动工作。
- 不创建节点会话。

生成文件：

- `workflow.json`：插件生成的结构化快照。
- `task.md`：插件根据已确认任务生成的 markdown 任务说明。
- `events.jsonl`：插件追加 `workflow_prepared` 事件。

模型通过工具参数提供任务文本；文件由插件写入。

### `sp_start`

用途：启动、恢复或重试 workflow task。这个工具要做到幂等。

输入：

```ts
{
  workflow_id: string
  task_id?: string
  policy?: "start" | "resume" | "retry" | "force_retry"
}
```

逻辑：

- workflow 处于 prepared 状态时，启动第一个可运行任务或 planning 节点。
- workflow 已经 running 时，返回现有 active sessions，不重复创建。
- 指定 `task_id` 且该 task 已 running 时，返回当前 session。
- 指定 `task_id` 且该 task failed、stale 或 recovered unknown 时，根据 `policy` 重试。
- 依赖未满足时，返回 `blocked_by`。
- 不从自然语言里重新拆任务，不凭空生成 task graph。
- 只启动 runtime memory / `tasks.json` 中已经存在的 task。
- 如果 workflow 还没有 `tasks.json`，只能启动由 workflow kind 决定的 bootstrap task，例如 planner、designer、debugger、investigator 或 verifier。
- 会话只能由插件调度。
- 每个节点 session 的 prompt 都由既有 task 定义、runtime state 和已持久化 report 渲染生成。

生成文件：

- `workflow.json`：更新 task/session 状态快照。
- `sessions.json`：更新 session lifecycle 快照。
- `events.jsonl`：追加 `task_started`、`session_started`、`task_restarted` 或 `session_reused`。
- `reports/<task_id>/task.md`：本次发给该 session 的完整 markdown prompt。

模型通过工具表达“开始工作”；插件决定创建或复用哪些 session，并在发送给 OpenCode 前写好 prompt 文件。这里生成的是 session prompt，不是新的 task 定义。

### `sp_cancel`

用途：取消 workflow、task 或 session。

输入：

```ts
{
  workflow_id: string
  task_id?: string
  session_id?: string
  reason?: string
}
```

逻辑：

- 只传 `workflow_id`：取消整个 workflow 和所有 active sessions。
- 传 `task_id`：取消该 task 和它的 active session。
- 传 `session_id`：只取消这次 session run，task 的后续重试策略由 runtime state 决定。
- OpenCode abort 可用时调用 abort。
- abort 失败或不可用时，把 session 标记为 `cancel_requested`，由 `sp_status` 暴露状态不一致。

生成文件：

- `workflow.json`：更新取消状态。
- `sessions.json`：更新 lifecycle 状态。
- `events.jsonl`：追加 `workflow_canceled`、`task_canceled`、`session_cancel_requested` 或 `session_canceled`。

### `sp_report`

用途：节点会话向 runtime 汇报结构化结果。

只有 node agents 可以拿到这个工具。`super-agent` 正常控制流程不使用它。

输入：

```ts
{
  workflow_id: string
  task_id?: string
  agent: NodeAgentName
  status: "progress" | "passed" | "failed" | "blocked" | "needs_user"
  summary: string
  report?: string
  checks?: string
  findings?: string
  question?: {
    prompt: string
    options?: string[]
  }
  task_graph?: TaskGraph | TaskGraphPatch
}
```

逻辑：

- 校验当前 OpenCode session 是否属于传入的 task 和 agent。session id 以工具 context 为准，不信模型手写的 session id。
- 写入该 task 或 check 的最新 markdown report。
- 如果包含 `task_graph`，按 task graph 提交规则合并或替换 `tasks.json`。
- 更新 runtime memory。
- 追加 report event。
- 执行 workflow transition 规则。
- 按 agent 类型和 report 状态关闭、停放或保持当前 session active。
- 需要时调度后续 session。

生成文件：

- `workflow.json`：更新 workflow 快照。
- `tasks.json`：如果 task graph 或 task 状态变化，更新任务图和任务状态。
- `sessions.json`：更新 lifecycle 状态。
- `events.jsonl`：追加 `report_received`、`task_passed`、`task_failed`、`check_passed`、`check_failed`、`session_closed` 等事件。
- `reports/<task_id>/` 下的 markdown report 文件。

节点模型通过 `sp_report` 提交结构化结果文本。插件负责写文件和控制后续 session。

#### Task graph 提交规则

`sp_report` 允许同一个 planner task 多次提交 task graph。这样可以避免一次工具调用传入过大的参数，也方便 planner 分阶段把任务讲清楚。

支持两种提交方式：

1. 小型 workflow：一次性提交完整 `TaskGraph`。
2. 大型 workflow：多次提交 `TaskGraphPatch`。

```ts
type TaskGraphPatch = {
  mode: "patch"
  batch_id: string
  tasks: Task[]
  edges?: Array<{ from: string; to: string }>
  remove_task_ids?: string[]
  complete?: boolean
  note?: string
}
```

合并规则：

- `batch_id` 用于幂等。相同 `batch_id` 重复提交时，runtime 只应用一次，或者按完全相同内容返回已应用。
- `tasks` 按 `task.id` upsert。已存在且未运行的 task 可以更新；已经 running、reported、passed 的 task 默认不能被 planner patch 覆盖。
- `edges` 更新依赖关系，runtime 校验不能形成环。
- `remove_task_ids` 只能删除还没有启动过的 task。
- `complete: true` 表示 planner 已提交完当前版本的 task graph。runtime 只有在 graph complete 后才按依赖启动后续 implement、investigate、verify 等 task。
- 如果 planner 需要继续补充任务，应再次 `sp_report(status: "progress", task_graph: TaskGraphPatch)`，runtime 写入 `tasks.json` 并追加事件。
- `status: "progress"` 表示本次 report 是中间进度，不触发 planner session 关闭，也不触发下游执行。
- `status: "passed"` 且 `complete: true` 时，runtime 才把 planner task 视为完成，并按 workflow definition 调度下一步。

文件落地：

- 每次 patch 都更新 runtime memory。
- 每次 patch 都写入 `tasks.json` 快照。
- 每次 patch 都追加 `events.jsonl`，事件包含 `batch_id`、新增/更新/删除 task 数量、是否 `complete`。
- planner 的长文本说明仍写入 `plan.md`；`task_graph` 只放结构化任务定义。

## Runtime 对象

### Workflow

```ts
type Workflow = {
  id: string
  kind: "feature" | "debug" | "plan-only" | "review" | "verify-finish" | "parallel-investigate"
  definition_version: string
  source_workflow_id?: string
  status: "prepared" | "running" | "waiting_user" | "blocked" | "passed" | "failed" | "canceled" | "recovered_unknown"
  task_path: "task.md"
  tasks: Task[]
  sessions: SessionRun[]
  result_task_id?: string
  created_at: string
  updated_at: string
}
```

`task.md` 是确认后的 workflow 任务说明，也是执行目标。原始对话保留在事件或 OpenCode 历史里，不作为节点 prompt 的默认来源。

### Task

```ts
type Task = {
  id: string
  title: string
  summary: string
  kind: "design" | "plan" | "debug" | "investigate" | "implement" | "acceptance" | "code_review" | "verification" | "finish"
  agent: NodeAgentName
  status: "pending" | "running" | "reported" | "passed" | "failed" | "blocked" | "waiting_user" | "canceled" | "stale"
  depends_on: string[]
  acceptance_criteria?: string[]
  files?: string[]
  test_commands?: string[]
  source_task_id?: string
  source_report_paths?: string[]
  current_session_id?: string
  reusable_session_id?: string
  checks?: CheckState[]
}
```

Task 在 workflow 内保持稳定。修复同一个 task 时更新该 task，不因为一次失败创建新 task；除非 workflow 本身被用户修改。

### 测试任务来源

`sp-verifier` 负责 fresh verification，不负责设计单元测试方案本身。

测试任务来源按优先级读取：

1. `tasks.json` 中当前 task 的 `test_commands`。
2. Debug 或 TDD 流程中已记录的 red test / verification target。
3. `plan.md` 中明确列出的验证命令。
4. 用户在 `sp_prepare` 确认任务时提供的验证要求。

Feature workflow 中，planner 应在 task graph 里为实现任务写入 `test_commands`。Implementer 可以在执行任务时补充或更新测试文件，但最终由 verifier 运行或核验 fresh verification，并把命令、结果和失败证据写入 `verification.md`。

如果 verifier task 没有可执行命令或明确验证目标，runtime 应把 workflow 置为 `blocked` 或 `waiting_user`，通过 `sp_status` 暴露缺失项，而不是让 verifier 自己猜测测试范围。

这里的 verifier 和 `acceptance -> verification -> code review` 中的 verification 是同一个 agent、同一种能力：`sp-verifier` 负责给出 fresh verification evidence。

区别在输入来源：

- 在 feature/debug/review 的检查链路里，verification 绑定一个已有 task，输入来自 `tasks.json`、implementation report、acceptance report 和 `test_commands`。
- 在独立 `verify-finish` workflow 里，verification 没有天然绑定的 implementation task。`sp_prepare` 必须生成 verifier task，并写清 verification target。

所以 `sp-verifier` 的问题不是角色重复，而是独立 verify-finish 场景如果没有 target，会拿不到足够数据来验证。

### SessionRun

```ts
type SessionRun = {
  id: string
  workflow_id: string
  task_id: string
  agent: NodeAgentName
  lifecycle: "active" | "reported" | "parked_reusable" | "closed" | "cancel_requested" | "canceled" | "lost"
  live_status?: "running" | "idle" | "error" | "missing" | "unavailable"
  started_at: string
  reported_at?: string
  closed_at?: string
  last_seen_at?: string
}
```

### CheckState

```ts
type CheckKind = "acceptance" | "verification" | "code_review"

type CheckState = {
  kind: CheckKind
  status: "pending" | "running" | "passed" | "failed" | "skipped" | "stale"
  summary?: string
  session_id?: string
  report_path?: string
}
```

编程实现类任务默认有三类检查，顺序固定：

- `acceptance`
- `verification`
- `code_review`

是否启用三类检查不是模型临时决定。

- Workflow definition 声明该 workflow 允许的 check 类型、默认 check 集和固定顺序。
- `sp_prepare` 可以根据用户确认的任务、风险等级和 workflow kind，在允许范围内生成本次 workflow 的实际 checks。
- `sp-planner` 可以在 task graph 中为具体 task 建议 checks，但 runtime 必须按 workflow definition 校验。
- 没有写入 task `checks` 的检查不会运行。
- 一旦 task 开始执行，checks 只能由 runtime 按失败修复、用户变更或 workflow policy 更新，不能由某个 node agent 自行删改。

Feature workflow 默认启用 `acceptance -> verification -> code_review`。Debug repair 默认至少启用 `verification`。Review workflow 根据 review 目标启用对应 checks。Parallel-investigate 默认没有编程 checks。

## Task 定义与 Session Prompt

这里要分清两个东西：

- Task 定义：workflow 中稳定存在的工作单元，写入 `tasks.json`。
- Session prompt：某次派发给某个 agent 的具体任务说明，写入 `reports/<task_id>/task.md`。

`sp_start` 不负责拆任务。它只负责从已有 task 中选择可运行项，并为选中的 task 创建或复用 session。

### Task 定义从哪里来

Task 定义有三个来源。

1. `sp_prepare` 为简单 workflow 创建单节点 task。

   例如用户只要做一次探索，`sp_prepare` 可以直接创建一个 investigator task，并写入 `tasks.json`。

2. `sp_prepare` 为复杂 workflow 创建 bootstrap task。

   例如 feature workflow 还没有 plan 时，插件根据 workflow kind 创建 planner task；debug workflow 创建 debugger task；verify-finish workflow 创建 verifier task。这类 task 是插件根据固定 workflow 模板生成的，不由 `sp_start` 生成。

3. `sp-planner` 通过 `sp_report(task_graph)` 提交正式 task graph。

   插件校验 task graph 后写入 `tasks.json`。任务少时可以一次性提交完整 graph；任务多时可以多次提交 patch，直到 planner 标记 `complete: true`。后续 runtime 只按依赖关系逐批启动 runnable tasks。

### Session Prompt 从哪里来

`reports/<task_id>/task.md` 是 session prompt 文件。它不是 task graph，也不是 workflow 的总任务说明。

生成逻辑：

1. Runtime 读取 `workflow.json`、workflow `task.md`、`tasks.json` 中的当前 task。
2. Runtime 按 agent 类型收集必要来源，例如 `spec.md`、`plan.md`、依赖任务 report、失败检查 report。
3. Runtime 用固定模板渲染 prompt。
4. Runtime 把 prompt 写入 `reports/<task_id>/task.md`。
5. Runtime 把同一份 prompt 发给 OpenCode session。

所以 `sp_start` 写 `reports/<task_id>/task.md` 的含义是“记录本次派发给模型的任务说明”，不是“生成新的业务任务”。

如果同一个 task 因修复被重新派发，插件更新 `reports/<task_id>/task.md` 为最新 prompt；旧 prompt 可以通过 `events.jsonl` 中的事件和 OpenCode 会话历史追溯。

## 目录结构

```text
.opencode/superpowers/
  workflows/
    <workflow_id>/
      workflow.json
      task.md
      spec.md
      plan.md
      tasks.json
      sessions.json
      events.jsonl
      reports/
        <task_id>/
          task.md
          report.md
          acceptance.md
          code_review.md
          verification.md
          investigation.md
          finish.md
      artifacts/
        <artifact_id>.md
```

只创建当前 workflow 会用到的文件。

### `workflow.json`

插件生成的结构化快照。

包含 workflow 元信息、状态、task 引用、session 引用、check state 摘要和 markdown report 路径。不存长 markdown 正文。

来源：

- `sp_prepare` 创建。
- `sp_start`、`sp_cancel`、`sp_report` 更新。

### `task.md`

插件生成的确认后 workflow 任务说明。

这是整个 workflow 的用户确认任务，不是原始对话，也不是第一条用户消息的转储。

来源：

- `sp_prepare` 根据 confirmed task input 创建。
- 用户明确修改 workflow 时，`sp_prepare(workflow_id)` 可以更新它。

### `spec.md`

designer 生成的产品或技术 spec。

来源：

- `sp-designer` 通过 `sp_report` 汇报。
- 插件把 report 内容写入 `spec.md`。

### `plan.md`

planner 生成的计划。

来源：

- `sp-planner` 通过 `sp_report` 汇报。
- 插件把 report 内容写入 `plan.md`。

### `tasks.json`

插件管理的 task graph。

来源：

- 通常来自 `sp-planner` 的 `sp_report(task_graph)`。
- 单节点 workflow 可以由 `sp_prepare` 直接生成。
- runtime 在 task 状态或 check 状态变化时更新。

### `sessions.json`

插件管理的 session lifecycle 快照。

来源：

- `sp_start`、`sp_cancel`、`sp_report` 更新。
- 记录 active、parked、closed、canceled、lost sessions。

### `events.jsonl`

workflow 的 append-only 事件日志。

来源：

- 插件在每次状态转换和文件生成动作时写入。
- 每条事件携带 `workflow_id`、`task_id`、`session_id`、`agent`、event type、path、timestamp 和短 summary。

这是唯一历史日志。不再维护 per-task `history.jsonl`。

### `reports/<task_id>/task.md`

插件生成的 markdown prompt，记录最新一次派发给该 task session 的任务说明。

用途：

- 人能直接审计当时给模型的任务。
- 节点 report 出问题时，有稳定的调试入口。

来源：

- `sp_start` 在发送 prompt 给 OpenCode 前写入。内容来自既有 task 定义、workflow 文件、上游 reports 和固定 prompt 模板。
- 同一 task retry 或 resume 时更新。
- 旧 prompt 可通过 `events.jsonl` 和 OpenCode session 历史追溯。

### `reports/<task_id>/report.md`

该 task 最新执行报告。

来源：

- `sp-implementer`、`sp-investigator`、`sp-debugger` 或其他 work agent 调用 `sp_report`。
- 插件把最新 report 正文写入这里。

### `reports/<task_id>/acceptance.md`

实现任务的最新 acceptance review。

来源：

- `sp-acceptance-reviewer` 调用 `sp_report`。
- 插件把最新验收报告写入这里。

### `reports/<task_id>/code_review.md`

实现任务的最新 code review。

来源：

- `sp-code-reviewer` 调用 `sp_report`。
- 插件把最新代码审查报告写入这里。

### `reports/<task_id>/verification.md`

实现任务或 finish task 的最新验证结果。

来源：

- `sp-verifier` 调用 `sp_report`。
- 插件把最新验证报告写入这里。

### `reports/<task_id>/investigation.md`

调查任务的最新 investigation report。

来源：

- `sp-investigator` 调用 `sp_report`。
- 插件把最新调查报告写入这里。

### `reports/<task_id>/finish.md`

finish task 的最新收尾报告。

来源：

- `sp-finisher` 调用 `sp_report`。
- 插件把最新收尾报告写入这里。

### `artifacts/<artifact_id>.md`

可选的非标准 markdown artifact。

只有当产物不适合放入上面固定文件时才使用。

来源：

- Node agent 通过 `sp_report` 提交额外 artifact 内容。
- 插件选择路径，并在 `workflow.json` 和 events 中记录。

## Agent 名称

Runtime agents：

- `sp-designer`
- `sp-planner`
- `sp-debugger`
- `sp-investigator`
- `sp-implementer`
- `sp-acceptance-reviewer`
- `sp-code-reviewer`
- `sp-verifier`
- `sp-finisher`

`sp-acceptance-reviewer` 负责检查实现是否满足已确认任务、spec、plan 和用户验收口径。

## Session 生命周期规则

`sp_report` 是 session run 的报告动作，不等于强制关闭会话。

默认状态流：

```text
active -> reported -> closed
```

报告动作：

- 写入 `reported_at`。
- 更新该 task 或 check 的 report 文件。
- 追加 `report_received` event。
- 由 runtime 根据 workflow definition 判断该 session 是否继续保留、停放或关闭。

关闭动作：

- 把 session 从 active/live 调度集合中移出。
- 写入 `closed_at`，把 lifecycle 更新为 `closed`。
- 后续 `sp_status` 默认把它当成历史 session。
- 重复关闭同一个 session 是幂等 no-op。

Planner 可以多次追加 plan 或 task graph。`sp_report(status: "progress")` 只更新 `reported_at`、`plan.md`、`tasks.json` 和 events，不关闭 session；`sp_report(status: "passed")` 表示 planner 当前输出完成，runtime 再决定是否关闭 planner session 并调度下游。

Implementation session 例外：

```text
active -> reported -> parked_reusable
```

Implementer session 在关联检查通过或 task 被取消前保持可复用。如果 acceptance、verification 或 code review 失败，runtime 会把修复 prompt 发回 parked implementer session。所有需要的检查通过后，runtime 关闭 implementer session。

Reviewer 和 verifier session 通常在最终 report 后关闭。它们的 findings 由 runtime 发回 implementer。需要多轮补充报告的 agent 可以先用 `status: "progress"` 追加内容。

## Workflow 定义策略

Runtime 使用插件内置的 workflow definition。总控 agent 不能临时发明 runtime 流程，也不能自己改 task transition、检查规则或归档规则。

总控可以做三件事：

1. 调用 `sp_prepare` 选择一个已注册的 `workflow.kind`。
2. 在 `sp_prepare` 参数里传入目标、约束、验收口径和是否允许执行。
3. 后续根据 `sp_status` 选择启动、取消或等待用户输入。

如果需要新的流程，应在插件里注册新的 workflow definition，再暴露为新的 `workflow.kind`。这样 runtime 才能知道起始节点、允许的 agent、任务图规则、检查策略、失败转移和汇总方式。

Workflow definition 至少包含：

```ts
type WorkflowDefinition = {
  kind: Workflow["kind"]
  version: string
  allowed_agents: NodeAgentName[]
  bootstrap_tasks: TaskTemplate[]
  graph_policy: "fixed" | "planner_generated" | "prepare_generated"
  checks_policy?: {
    allowed: CheckKind[]
    default_for_implement?: CheckKind[]
    order: CheckKind[]
  }
  transitions: TransitionRule[]
  aggregation: "finish_task" | "direct_report" | "wait_user"
}
```

动态调整边界：

- 允许动态调整 task 数量、依赖关系、是否需要某些检查，但调整必须发生在 workflow definition 允许的范围内。
- Planner 可以通过 `sp_report(task_graph)` 生成或 patch 任务图；runtime 负责校验 graph policy。
- Review、verification、debugger 可以触发 repair task，但只能使用 workflow definition 允许的 repair 路径。
- 总控不能直接把一个 feature workflow 临时改成任意 DAG。如果确实需要，应创建新的 workflow kind，或者让 planner 在 `planner_generated` 规则内提交 task graph。

结果汇总规则：

- 有 `sp-finisher` 的 workflow，由 finisher 读取 workflow 状态、task reports 和 check reports，生成 `reports/<finish_task_id>/finish.md`。
- 没有 finisher 的 workflow，由 runtime 直接把最后一个 node report 标记为 workflow result。
- 汇总完成后，runtime 更新 `workflow.result_task_id`、`workflow.status`，追加 `workflow_finished` 事件。
- 总控通过 `sp_status(workflow_id)` 读取最终状态、result path、关键 summary 和未完成项。

## Workflow 处理逻辑

### Feature

典型流程：

```text
sp_prepare
-> sp_start
-> sp-designer
-> sp-planner
-> sp-implementer task(s)
-> sp-acceptance-reviewer
-> sp-verifier
-> sp-code-reviewer
-> sp-finisher
```

文件生成：

- `sp_prepare` 写入 `workflow.json`、workflow `task.md` 和 `events.jsonl`。
- `sp-designer sp_report` 写入 `spec.md`。
- `sp-planner sp_report` 写入 `plan.md` 和 `tasks.json`。
- `sp_start` 为每个被派发的 task 写入 `reports/<task_id>/task.md`。
- `sp-implementer sp_report` 写入 `reports/<task_id>/report.md`。
- `sp-acceptance-reviewer sp_report` 写入 `reports/<task_id>/acceptance.md`。
- `sp-verifier sp_report` 写入 `reports/<task_id>/verification.md`。
- `sp-code-reviewer sp_report` 写入 `reports/<task_id>/code_review.md`。
- `sp-finisher sp_report` 写入 `reports/<task_id>/finish.md`。

Runtime 行为：

- Graph policy 是 `planner_generated`。`sp_prepare` 只创建 designer 或 planner bootstrap task，不直接创建 implementation task graph。
- Designer 完成后，runtime 启动 planner；如果无需独立 design，可由 workflow definition 允许直接进入 planner。
- Planner 可以一次或多次提交 task graph；graph complete 后，runtime 只启动依赖已满足的 implement task。
- 每个 implement task 完成后，runtime 按 task `checks` 串行启动检查。Feature 默认 checks 是 acceptance、verification 和 code review，但可以由 `sp_prepare` 在 workflow definition 允许范围内裁剪。
- 已启用 checks 的执行顺序固定为 acceptance、verification、code review。
- Implementation task passed 只表示实现准备进入检查，不表示 task 完成。
- 所有检查通过后，task 变为 `passed`，相关 sessions 被关闭。
- 任一检查失败时，task 变为 `stale` 或 `failed`，失败检查 summary 会发给 parked implementer session，相关 checks 重置为 `pending` 或 `stale`。
- 所有 implementation task passed 后，runtime 启动 finish task。

汇总方式：

- `sp-finisher` 汇总 `spec.md`、`plan.md`、`tasks.json`、每个 implement report 和检查 report。
- `finish.md` 输出完成项、验证结果、遗留风险、用户可继续执行的下一步。
- Runtime 把 finish task 标记为 `result_task_id`，workflow 状态设为 `passed`、`failed` 或 `blocked`。

### Debug

只诊断的流程：

```text
sp_prepare
-> sp_start
-> sp-debugger
-> sp-finisher
```

需要修复的流程：

```text
sp-debugger
-> sp-implementer
-> sp-verifier
-> sp-finisher
```

文件生成：

- `sp-debugger sp_report` 写入 `reports/<task_id>/report.md`；如果 report 包含 root-cause artifact，插件同时写入 `artifacts/root_cause.md`。
- 修复任务沿用 feature implementation task 的 `report.md` 和 `verification.md` 规则。

Runtime 行为：

- Graph policy 默认是 `fixed`。`sp_prepare` 创建 debugger bootstrap task。
- Debugger 只汇报 root cause 时，runtime 可以进入 finish，或等待用户确认是否修复。
- 需要修复时，runtime 创建 implementer task，并把 debugger report 作为输入来源。
- 修复完成后至少启动 verification；如果 task `checks` 里还有其他检查，runtime 按 acceptance、verification、code review 的顺序执行。

汇总方式：

- 只诊断时，`sp-finisher` 汇总 root cause、证据、影响范围和建议动作。
- 诊断并修复时，`sp-finisher` 额外汇总修复 report 和 verification report。
- 如果 debugger 报告 `needs_user`，runtime 不生成最终 finish，workflow 进入 `waiting_user`，由 `sp_status` 暴露问题和选项。

### Plan-Only

流程：

```text
sp_prepare
-> sp_start
-> sp-planner
-> passed

用户确认执行后：

sp_prepare(source_workflow_id = plan_only_workflow_id)
-> sp_start
-> feature/debug/review workflow
```

文件生成：

- `sp-planner sp_report` 写入 `plan.md` 和 `tasks.json`。
- 不需要 implementation report 或 checks。

Runtime 行为：

- Graph policy 是 `planner_generated`，但 workflow 不自动执行 implementation task。
- Planner report 完成后关闭 planner session。
- 如果 planner 提交了 task graph，runtime 只保存 `tasks.json`，不启动 implementer。
- Plan-only workflow 可以正常结束为 `passed`。
- 如果用户后续确认执行，总控可以调用 `sp_prepare` 创建新的执行 workflow，并通过 `source_workflow_id` 引用 plan-only 的 `plan.md` 和 `tasks.json`。
- 这一步必须有用户确认；不能因为 plan-only 结束就自动执行。

汇总方式：

- 默认没有 `sp-finisher`。Planner 的 `plan.md` 就是 workflow result。
- Runtime 把 planner task 设为 `result_task_id`。
- 如果 workflow definition 要求收尾摘要，也可以派发 `sp-finisher` 生成 `finish.md`，但不改变不执行代码的边界。

### Review

不修复的流程：

```text
sp_prepare
-> sp_start
-> sp-acceptance-reviewer
-> sp-verifier
-> sp-code-reviewer
-> sp-finisher
```

需要修复的流程：

```text
review failed
-> sp-implementer
-> rerun failed checks
```

文件生成：

- Acceptance review 写入 `reports/<task_id>/acceptance.md`。
- Verification 写入 `reports/<task_id>/verification.md`。
- Code review 写入 `reports/<task_id>/code_review.md`。
- 修复任务写入 `reports/<task_id>/report.md`。

Runtime 行为：

- Graph policy 可以是 `fixed` 或 `prepare_generated`。如果 review 目标是已有 task，runtime 直接创建对应 reviewer task；如果目标是一组文件或报告，`sp_prepare` 生成 review task，并补齐 task definition、acceptance criteria、source files、review target 和需要运行的 checks。
- 如果 review 针对已有 implementation task，runtime 把 review 关联到该 task，并读取该 task 的 `task.md`、`spec.md`、`plan.md` 和 `report.md`。
- 如果 review 是独立发起的，`sp_prepare` 必须把用户确认后的 review 目标写入 workflow `task.md` 和 `tasks.json`。没有明确验收口径时，不启动 acceptance reviewer，先进入 `waiting_user`。
- 如果 review 发现问题但没有可复用 implementer session，runtime 返回用户决策点，或在用户确认后创建修复 workflow。
- Review workflow 自身不直接修改代码，除非 workflow definition 明确允许进入 repair path。

汇总方式：

- 单个 reviewer 时，review report 就是 result。
- 多个 reviewer 时，`sp-finisher` 按 acceptance、verification、code review 的顺序汇总结论、阻塞项和建议处理顺序。
- 如果进入 repair path，最终结果由 repair task 的 checks 和 finish report 决定。

### Verify-Finish

流程：

```text
sp_prepare
-> sp_start
-> sp-verifier
-> sp-finisher
```

文件生成：

- `sp-verifier sp_report` 写入 `reports/<task_id>/verification.md`。
- `sp-finisher sp_report` 写入 `reports/<task_id>/finish.md`。

Runtime 行为：

- Graph policy 默认是 `fixed`。`sp_prepare` 创建 verifier task，必要时关联目标 task 或目标 workflow。
- 如果关联已有 task，verifier 读取该 task 的 `test_commands`、implementation report 和已有检查结果。
- 如果是独立 verify-finish，`sp_prepare` 必须在 verifier task 中写入 verification target，包括目标文件、验证命令、预期结果和证据要求。
- Verification 失败且 task 关联了 implementer session 时，runtime 复用该 session。
- 没有关联 implementer 时，workflow 进入 `blocked`，`sp_status` 说明需要准备或启动一个 repair task。

汇总方式：

- Verification 通过时，`sp-finisher` 汇总执行命令、结果证据和剩余风险。
- Verification 失败时，`sp-finisher` 可以生成失败摘要；如果需要开发修复，workflow 先进入 `blocked` 或 repair path，不直接标记通过。

### Parallel-Investigate

简单调查流程：

```text
sp_prepare
-> sp_start
-> sp-investigator task A
-> sp-investigator task B
-> sp-investigator task C
-> aggregate or finish
```

复杂调查流程：

```text
sp_prepare
-> sp_start
-> sp-planner
-> task_graph complete
-> sp-investigator task(s)
-> aggregate or finish
```

文件生成：

- 每个 investigator prompt 写入 `reports/<task_id>/task.md`。
- 复杂调查中，`sp-planner sp_report` 写入 `plan.md` 和 `tasks.json`。
- 每个 investigator report 写入 `reports/<task_id>/investigation.md` 或 `reports/<task_id>/report.md`。

Runtime 行为：

- Graph policy 是 `prepare_generated` 或 `planner_generated`。
- 简单并行调查由 `sp_prepare` 按用户确认后的主题生成 investigation tasks。
- 复杂调查先启动 planner；planner 通过 task graph 拆分调查分支，graph complete 后 runtime 再派发 investigator tasks。
- Investigator session 在最终 report 后关闭。
- 默认不需要编程检查。
- workflow 只有一个 investigation task 时，可以在一次 report 后完成。
- 多个 task 时，runtime 等所有 task passed 后，再派发 finish 或 aggregation task。

汇总方式：

- 单任务调查可以把 investigation report 作为 result。
- 多任务调查由 `sp-finisher` 汇总所有 investigation reports，输出共识、分歧、证据缺口和建议下一步。
- 如果某个 investigation blocked，runtime 可以根据 definition 决定是等待用户、跳过该分支，还是让 finisher 输出 partial result。

## Agent 输入来源

Runtime 生成每个 session prompt。Agent 不自己拼 source context。每个生成的 `reports/<task_id>/task.md` 都应该包含 source list。

### `sp-designer`

输入：

- Workflow `task.md`
- 已有 `spec.md`，仅当用户明确要求修改现有设计时使用
- `events.jsonl` 中和恢复有关的事件，只作为 recovery notes

输出：

- `spec.md`
- 可选 `artifacts/<artifact_id>.md`

### `sp-planner`

输入：

- Workflow `task.md`
- 已存在的 `spec.md`
- 已存在的 `plan.md`，仅当修改计划时使用

输出：

- `plan.md`
- `tasks.json`

### `sp-debugger`

输入：

- Workflow `task.md`
- 如果是在已有 workflow 里定位问题，读取被选中 task 的相关 reports
- 继续 recovered workflow 时，读取 `sp_status` 返回的 runtime 状态

输出：

- `reports/<task_id>/report.md`
- 可选 root-cause artifact

### `sp-investigator`

输入：

- Workflow `task.md`
- 当前 task 定义，来自 `tasks.json`
- 直接依赖任务的 reports

输出：

- `reports/<task_id>/investigation.md` 或 `reports/<task_id>/report.md`

### `sp-implementer`

输入：

- Workflow `task.md`
- `spec.md`
- `plan.md`
- 当前 task，来自 `tasks.json`
- 直接依赖任务的 reports
- Debug repair workflow 中的 debugger report
- 修复 review 或 verification findings 时的失败检查 reports

输出：

- `reports/<task_id>/report.md`

生命周期：

- 成功 report 后进入 parked reusable。
- Acceptance、verification 或 code review 失败时复用。
- 所有需要的检查通过后关闭。

### `sp-acceptance-reviewer`

输入：

- Workflow `task.md`
- `spec.md`
- `plan.md`
- 当前 task，来自 `tasks.json`
- `reports/<task_id>/report.md`

输出：

- `reports/<task_id>/acceptance.md`

判断：

- Passed 表示实现满足确认后的任务、spec、plan 和当前 task 目标。
- Failed 的 findings 会发回 implementer。

### `sp-code-reviewer`

输入：

- Workflow `task.md`
- `spec.md`
- `plan.md`
- 当前 task，来自 `tasks.json`
- `reports/<task_id>/report.md`
- 已存在的 `reports/<task_id>/acceptance.md`
- 已存在的 `reports/<task_id>/verification.md`
- 实现 report 和 verification report 里的相关 checks

输出：

- `reports/<task_id>/code_review.md`

判断：

- Passed 表示代码质量风险可接受。
- Failed 的 findings 会发回 implementer。

### `sp-verifier`

输入：

- Workflow `task.md`
- `plan.md`
- 当前 task，来自 `tasks.json`，重点读取 `test_commands`
- `reports/<task_id>/report.md`
- 已存在的 `reports/<task_id>/acceptance.md`

输出：

- `reports/<task_id>/verification.md`

判断：

- Passed 表示有 fresh verification evidence。
- Failed 的 evidence 会尽量发回 implementer。

### `sp-finisher`

输入：

- Workflow `task.md`
- `workflow.json`
- `tasks.json`
- 所有 task 的最新 reports 和 checks

输出：

- `reports/<task_id>/finish.md`

判断：

- Passed 表示 workflow 可以标记为完成。

## 验证计划

- 新 public tool registry 的单元测试：
  - `super-agent` 只能看到 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`。
  - Node agents 能看到 `sp_report`。
- 文件生成单元测试：
  - `sp_prepare` 写入 `workflow.json`、`task.md` 和 `events.jsonl`。
  - `sp_start` 写入 `reports/<task_id>/task.md`。
  - `sp_report` 写入对应的最新 markdown 文件，并追加 events。
- Transition 测试：
  - implementer passed 后 park session 并启动 checks。
  - checks 按 acceptance、verification、code review 顺序运行。
  - acceptance、verification 或 code review failed 后复用 implementer。
  - 所有 checks passed 后关闭 implementer，并把 task 标记为 passed。
  - Plan-only 的 planner passed 后保存 `plan.md` 和 `tasks.json`，workflow 结束为 `passed`，不启动 implementer。
  - Parallel-investigate 的 investigation passed 后启动 finish；finish 不要求 `verification_fresh`。
- E2E 更新：
  - 覆盖五个工具的完整链路：`sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
  - 每类 workflow 至少有一条完整闭环用例：
    - Feature：`prepare -> start -> design -> plan -> implement -> acceptance -> verification -> code-review -> finish`。
    - Debug repair：`start -> debug -> implement -> acceptance -> verification -> code-review -> finish`。
    - Plan-only：`start -> planner -> passed`，确认不会派发 implementer。
    - Review：`start -> acceptance -> verification -> code-review -> finish`。
    - Verify-finish：`start -> verification -> finish`，同时保留 fresh verification gate 失败恢复用例。
    - Parallel-investigate：`start -> investigator -> finish`。
  - 补充门禁和恢复用例：strict debug 写入阻断、record validation recovery、active waiting reroute、execute gate order。
