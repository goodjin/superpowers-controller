# Superpowers Controller PRD V5

## 1. Version

- Version: v5
- Date: 2026-06-28
- Status: proposed PRD draft
- Supersedes: `docs/superpowers/specs/2026-06-27-controller-prd-v4.md`

v5 继承 v4 的 public tool surface、controller autonomy、non-blocking dispatch、runtime recovery、`sp_report` result contract、TUI progress 可见性和主会话按需 progress digest。

v5 的核心变化是取消固定 workflow 语义。插件不再内置 `feature/debug/plan-only/review/verify-finish/parallel-investigate` 这类固定流程作为主决策来源。插件不负责智能规划 workflow；它只提供 agent 能力目录、workflow schema、常用 workflow 示例、结构校验、状态机运行时、派发控制、结果归档、恢复和可见性。controller 根据用户原始需求生成本次 workflow spec，插件按该 spec 控制不同 agent 执行。

一句话目标：

```text
controller 生成 workflow；plugin 执行 workflow；agent 通过 sp_report 交回结果；plugin 根据结构化结果和 workflow spec 推进或反馈 controller。
```

## 2. Product Positioning

Superpowers Controller 是一个 controller-driven workflow runtime plugin。

职责边界：

- controller 负责理解用户需求、确认范围、生成本次 workflow spec、解释结果并在需要时做决策。
- plugin 负责持久化 workflow spec、创建和恢复 node session、注入 node prompt、收集 `sp_report`、计算可执行下一步、处理超时/未汇报/取消/恢复，并向 controller 返回结构化反馈。
- node agent 只执行当前 node，完成后调用 `sp_report` 提交结构化结果。

插件可以暴露静态能力和常用 workflow 示例，帮助 controller 生成 spec，但最终规划由 controller 完成。插件不能根据用户自然语言替 controller 选择、生成或修改业务 workflow。

v5 的基础循环保持五个 public tool：

```text
sp_status -> sp_prepare -> sp_start -> sp_report -> transition
                         \-> sp_cancel
```

区别在于：

- v4: `workflow` 字段选择一个内置流程，插件按固定 workflow definition 派发节点。
- v5: `workflow_spec` 是 controller 生成并确认的结构化 DAG，插件按这个 DAG 派发节点。

## 3. V5 Goals

- 不再把固定 workflow 类型作为主流程来源。
- 允许 controller 为每次请求动态生成 workflow spec。
- 插件只做能力暴露、schema 校验和执行控制，不替 controller 决定业务流程。
- 每个 node 必须有 agent、任务说明、预期输出和 `sp_report` 契约。
- 每个 agent 完成后必须调用 `sp_report`。
- 如果 agent 没有调用 `sp_report`，插件必须生成一次 fallback summary result，并把它反馈给 controller 决策。
- `sp_report` 或 fallback summary result 进入统一 transition 入口。
- transition 优先按 workflow spec 的 edge/condition 执行；无法安全判断时返回 controller decision。
- 保持 public tool surface 稳定，不为动态 workflow 新增 public tool。
- 保持 progress 是可见性 side-channel，不驱动 transition。

## 4. Non-Goals

- 不让插件自行做需求理解、产品设计或任务拆解。
- 不让 node agent 直接创建新的 workflow 或绕过 controller。
- 不把 fallback summary 等同于成功结果。
- 不在没有结构化依据时自动继续高风险节点。
- 不通过 native task 或 native question 绕过 `sp_start` / `sp_report`。
- 不要求 v5 第一版支持复杂表达式语言；condition 可以先是枚举化结果匹配和人工决策点。

## 5. Public Tool Surface

v5 仍只暴露：

```text
sp_status
sp_prepare
sp_start
sp_cancel
sp_report
```

### 5.1 `sp_status`

`sp_status` 是只读事实查询，并可返回确定性的能力目录。

返回内容包括：

- 当前 workflow spec。
- 当前 node 状态。
- 最近 `sp_report` 或 fallback summary result。
- 可运行 node。
- 阻塞原因。
- controller_feedback。
- 可选 progress_digest。
- agent catalog、workflow schema 能力和常用 workflow 示例。

`sp_status` 不生成 workflow，不修改 workflow。

### 5.2 `sp_prepare`

`sp_prepare` 在 v5 中只处理 controller 已生成的 workflow spec。它不根据用户请求生成 workflow，也不返回智能规划建议。

#### Validation mode

当 controller 已生成 workflow spec，但还没有决定是否注册时，可以调用 validation mode 做 dry-run 校验。

输入：

```ts
type SpPrepareValidationInput = {
  mode: "validate_workflow"
  request: string
  workflow_spec: GeneratedWorkflowSpec
}
```

输出：

```ts
type WorkflowValidationResult = {
  valid: boolean
  errors: string[]
  warnings: string[]
  required_user_confirmations: string[]
  referenced_agents: AgentName[]
  referenced_documents: string[]
}
```

Validation mode 不创建 workflow、不派发 child session、不写入 draft state。它只返回 schema、agent、edge、document contract、report contract 和确认点校验结果。

#### Workflow registration mode

当 controller 已生成 workflow spec 并获得用户确认时，`sp_prepare` 写入 draft workflow。

输入：

```ts
type SpPrepareWorkflowInput = {
  mode: "register_workflow"
  request: string
  workflow_spec: GeneratedWorkflowSpec
}
```

行为：

- 校验 workflow spec 的结构完整性。
- 校验 node agent 是否存在。
- 校验每个 node 是否有 report_contract。
- 校验 document contract 是否能和 node 输入输出对应。
- 写入 draft state。
- 返回 `recommended_next: approve_workflow | revise_workflow | cancel_workflow`。

`sp_prepare` 不再根据固定 `workflow kind` 自动派发 designer/planner。controller 可以把 designer/planner 放进 workflow spec；插件只按 spec 执行。

### 5.3 `sp_start`

`sp_start` 负责激活、恢复、重试或继续动态 workflow。

行为规则：

- `draft + approve_workflow`: 激活已确认 workflow spec，派发第一个 runnable node。
- `active + running node`: 返回 wait，不重复派发。
- `active + node reported`: 根据 workflow spec 计算下一个 runnable node。
- `active + fallback_summary_result`: 返回 controller decision，除非 workflow spec 显式允许 fallback summary 继续。
- `active + waiting_controller_decision`: 只有 controller 显式选择后才继续。
- `active + waiting_user`: 通过 `resume_input` 恢复原 child session。
- `recovered_unknown`: 需要 controller 选择 retry/cancel/inspect。

### 5.4 `sp_report`

`sp_report` 仍是 node result 进入 runtime 的主入口。

每个 node prompt 必须要求 agent 在完成、阻塞、失败或需要用户输入时调用 `sp_report`。

`sp_report` 至少包含：

```ts
type SpReportInput = {
  node_id?: string
  event: string
  status: "progress" | "passed" | "failed" | "blocked" | "needs_user"
  summary: string
  artifacts?: Record<string, string>
  checks?: string
  findings?: string
  question?: {
    prompt: string
    options?: Array<{ label: string; description?: string }>
  }
}
```

`sp_report` 不能包含 `next_action`、`next_suggestion`、`child_session_id`、`reuse_session_id` 或其它 control-plane 字段。node agent 可以在 `summary` 或 `findings` 中描述观察和风险，但不能指挥插件派发下一步。

### 5.5 `sp_cancel`

`sp_cancel` 取消 workflow、node 或 session。取消后，恢复必须读取当前 state 和 workflow spec，不能回退到固定 workflow entrypoint。

## 6. Generated Workflow Spec

v5 的核心数据结构是 controller 生成的 workflow spec。

```ts
type GeneratedWorkflowSpec = {
  version: "v5"
  title: string
  goal: string
  constraints: string[]
  nodes: WorkflowNodeSpec[]
  edges: WorkflowEdgeSpec[]
  documents?: WorkflowDocumentSpec[]
  completion_policy: CompletionPolicy
  fallback_policy: FallbackPolicy
}

type WorkflowNodeSpec = {
  id: string
  agent: AgentName
  title: string
  task: string
  required_context?: string[]
  consumes?: string[]
  produces?: string[]
  expected_output: string
  report_contract: ReportContract
  timeout_policy?: TimeoutPolicy
  no_report_policy?: NoReportPolicy
}

type WorkflowDocumentSpec = {
  id: string
  title: string
  kind: "workflow_artifact" | "workspace_output"
  path: string
  producer_node_id: string
  consumer_node_ids?: string[]
  promotion:
    | "on_node_passed"
    | "on_controller_approval"
    | "on_workflow_finish"
    | "none"
  required: boolean
}

type WorkflowEdgeSpec = {
  from: string
  to: string
  condition:
    | { kind: "on_status"; status: "passed" | "failed" | "blocked" | "needs_user" }
    | { kind: "on_artifact"; artifact: string }
    | { kind: "controller_decision"; options: string[] }
}
```

结构规则：

- `nodes[].id` 必须唯一。
- 每个 `node.agent` 必须存在于 agent catalog。
- 每个 node 必须有 `report_contract`。
- `nodes[].consumes` 和 `nodes[].produces` 只能引用 `documents[].id`。
- `documents[].producer_node_id` 必须引用存在的 node。
- `kind="workflow_artifact"` 的 `path` 相对 `.opencode/superpowers/runs/<run-id>/`，例如 `spec.md`、`plan.md`、`task_graph.json`、`reports/<task-id>/report.md`。
- `kind="workspace_output"` 的 `path` 相对项目工作区，例如 `docs/features/<name>.md` 或 `docs/modules/<module>.md`。workspace output 默认不是 node context，除非 workflow spec 显式要求插件读取并作为 source artifact 传递。
- edge 只能引用存在的 node。
- graph 可以是 DAG；第一版不支持环，retry 通过新 attempt 记录实现。
- 没有入边的 node 是 initial runnable node。
- completion policy 必须说明何时 workflow passed、failed、blocked 或需要 controller decision。

## 7. Workflow Document Lifecycle

v5 把“文档”分成三类：

- runtime control documents: 插件为了调度、恢复和审计生成的内部文件，例如 `workflow-spec.json`、`state.json`、`events.jsonl`、`documents.json`、`nodes/<node-id>/task.md`、`nodes/<node-id>/record.json`、`nodes/<node-id>/fallback-summary.json`。这类文件不直接作为业务上下文让 node 自己查找。
- workflow artifact documents: 放在 `.opencode/superpowers/runs/<run-id>/` 下、由插件读取并内联传给 node agent 的上下文文件，例如 `request.md`、`spec.md`、`plan.md`、`task_graph.json`、`tasks.json`、`reports/<task-id>/task.md`、`reports/<task-id>/report.md`、`reports/<task-id>/verification.md`。node 消费的 `spec.md`、`plan.md` 指的是这一层。
- workspace output documents: node agent 根据项目规则或用户要求写入项目工作区的交付文档，例如 `docs/features/*.md`、`docs/bugfix/*.md`、`docs/modules/*.md`。它们默认不是下游 node 的消费材料；只有 workflow spec 显式声明时，插件才读取并作为 source artifact 传递。

生成时机：

1. controller intake 阶段只在主会话中澄清和展示草案；用户未批准前不需要写入 workspace document。
2. `sp_prepare(mode="register_workflow")` 写入 runtime control documents，包括 `workflow-spec.json`、`documents.json`、draft state 和事件日志。
3. `sp_start` 派发 node 前，插件生成 `nodes/<node-id>/task.md`。如果 node 绑定 `task_id`，同时生成 `reports/<task-id>/task.md`。
4. designer/planner 等 node 通过 `sp_report.artifacts` 提交 `spec`、`plan`、`task_graph` 等结构化结果后，插件把它们写入 run 目录下的 workflow artifact candidate，例如 `nodes/<node-id>/output.md` 或 candidate record。
5. controller 批准后，插件把 candidate promotion 为 canonical workflow artifact，例如 `spec.md`、`plan.md`、`task_graph.json`、`tasks.json`。
6. 后续 node 派发前，插件读取 `documents[].consumer_node_ids` 允许且已经 canonical 的 workflow artifacts，内联进 node prompt 的 source artifacts。node 不应该自行去项目目录搜索 `spec.md` 或 `plan.md`。
7. 如果 workflow spec 要求 workspace output，node agent 负责创建或修改项目工作区文件，并在 `sp_report` 中报告路径和摘要；workspace output 是否再被后续 node 消费，需要显式声明为 source artifact。
8. `sp_report(status="progress")` 产生的 artifact 只能是 candidate/progress；不触发 promotion，也不解锁下游节点。

常见文档关联：

- spec 文档：通常由 `sp-designer` 生成，先作为 run 目录下的 candidate；批准后 promotion 为 canonical `spec.md`，由插件读取并传给 planner。
- plan/task graph 文档：通常由 `sp-planner` 生成，批准后 promotion 为 canonical `plan.md`、`task_graph.json` 和 `tasks.json`，由插件读取并传给 implementer、reviewer 和 verifier。
- task packet 文档：由插件在 dispatch 时生成，始终绑定具体 `node_id`，用于审计 child prompt。
- implementation/report/check 文档：由 `sp_report` 写入 node record 和 task-scoped report；接受、验证、代码审查节点按同一 `task_id` 关联。
- workspace feature/bugfix/module 文档：如果项目规则要求写入 `docs/features/`、`docs/bugfix/` 或 `docs/modules/`，它们是 workspace output。它们可以由 designer、planner、finisher 或 documentation node 生成，但不是默认的 node 消费文档。

## 8. Runtime Decision Model

插件根据三类输入计算下一步：

1. 当前 `WorkflowState`。
2. controller 生成的 `GeneratedWorkflowSpec`。
3. 最新 node result: `sp_report` 或 fallback summary result。

transition 输出只能是：

- `create_session`: 创建 node session。
- `reuse_session`: 复用已有 node session。
- `wait_user`: 等待用户输入。
- `wait_controller`: 等待 controller 决策。
- `finish`: workflow 结束。
- `blocked`: runtime 无法安全继续。

插件可以自动推进的条件：

- report status 与 workflow edge condition 明确匹配。
- 下一个 node agent 存在。
- required context 可解析。
- 没有 controller decision edge。
- 没有 unresolved user input。

插件必须返回 controller 的条件：

- 多条 edge 同时匹配且优先级不明确。
- node 没有调用 `sp_report`，只得到 fallback summary。
- report status 与 spec condition 不匹配。
- report 缺少 required artifact。
- agent 不存在或权限不可用。
- workflow spec 不完整。
- 执行下一步会产生用户未确认的高风险外部副作用。

## 9. No-Report Fallback Summary

每个 agent 应调用 `sp_report`。如果没有调用，插件不能让 workflow 静默卡住。

触发条件：

- child session 进入 idle/completed，但没有对应 node 的 terminal `sp_report`。
- child session 异常结束，且没有 `sp_report`。
- child session 长时间 stalled，超过 node 的 `no_report_policy` 或默认阈值。
- plugin startup recovery 发现 node 之前 running，但没有 terminal report。

fallback 行为：

1. 插件收集该 child session 的可见输出、tool progress、patch progress、error 和 transcript 摘要。
2. 插件生成 `FallbackSummaryResult`。
3. 插件把 node 标记为 `summary_fallback` 或 `waiting_controller_decision`。
4. 插件把 summary result 返回给 controller。
5. 插件不把 fallback summary 当成 `passed`，除非 workflow spec 明确允许。

```ts
type FallbackSummaryResult = {
  kind: "fallback_summary"
  node_id: string
  agent: AgentName
  reason:
    | "missing_sp_report"
    | "session_idle_without_report"
    | "session_error_without_report"
    | "startup_recovered_without_report"
    | "stalled_without_report"
  summary: string
  evidence: Array<{
    source: "progress" | "transcript" | "tool" | "error" | "artifact"
    text: string
  }>
  confidence: "low" | "medium" | "high"
  recommended_next:
    | "ask_controller"
    | "retry_node"
    | "accept_as_partial"
    | "cancel_workflow"
}
```

如果没有足够内容生成摘要，summary 必须明确写出“没有可靠输出”，并建议 controller retry 或 inspect。

## 10. Controller Feedback Contract

所有 public tool 返回值必须继续包含 controller_feedback。

v5 增加以下 outcome：

```ts
type ControllerOutcome =
  | "capability_catalog"
  | "workflow_registered"
  | "node_running"
  | "node_reported"
  | "fallback_summary_ready"
  | "waiting_controller_decision"
  | "waiting_user"
  | "blocked"
  | "terminal"
```

`controller_feedback` 必须说明：

- 当前 workflow spec 是否有效。
- 当前 node 是否有 terminal report。
- 如果是 fallback summary，为什么生成、证据是什么、能否自动继续。
- controller 可选动作。
- 允许调用哪些 public tools。

## 11. Agent Catalog, Schema, And Workflow Examples

插件维护 agent catalog、workflow schema 和常用 workflow 示例，但不把这些内容组合成智能建议，也不根据用户请求选择 workflow。

agent catalog 只描述：

- agent name。
- agent capability。
- primary skill。
- permissions。
- expected report pattern。
- unsuitable scenarios。

workflow examples 是静态样例，用于总控 prompt 和能力展示。它们不具备强制力，也不是插件的规划结果。

常用示例包括：

- feature with unclear requirements: intake -> design/spec -> approval -> plan/task graph -> implementation tasks -> acceptance -> verification -> code review -> finish。
- simple scoped implementation: intake -> implementation -> verification -> optional review -> finish。
- bugfix: intake/reproduce -> root cause investigation -> repair plan or implementation -> regression verification -> review -> finish。
- design-only or plan-only: design or plan node -> user review -> terminal, without implementation nodes。
- review-only: acceptance or code review node -> verification when needed -> controller decision or finish。
- parallel investigation: independent investigator nodes -> synthesis/finish -> controller decision before any write action。

controller 生成 workflow spec 时可以参考这些示例，但必须按用户目标、项目规则、风险和确认点裁剪。

## 12. Persistence And Audit

v5 需要持久化：

```text
.opencode/superpowers/runs/<run-id>/
  workflow-spec.json
  documents.json
  state.json
  events.jsonl
  nodes/<node-id>/task.md
  nodes/<node-id>/record.json
  nodes/<node-id>/fallback-summary.json
  nodes/<node-id>/progress.jsonl
```

审计要求：

- controller 生成的 workflow spec 必须落盘。
- capability catalog 和 workflow examples 是静态能力说明；registered workflow spec 是本次运行的权威计划，两者必须分开。
- workflow artifacts 必须通过 `documents.json` 记录 document id、run-relative path、producer node、consumer nodes、candidate/canonical 状态和 promotion 事件。
- workspace outputs 如果需要追踪，也通过 `documents.json` 记录 workspace-relative path、producer node 和是否需要作为 source artifact 传给后续节点。
- fallback summary 必须落盘，不能只在 tool response 中出现。
- sp_report result 和 fallback summary result 必须进入统一 node history。
- late report 不能覆盖 fallback summary 后的新 attempt，除非 controller 显式选择采用。

## 13. TUI And Progress Requirements

TUI surface 不再假设固定 workflow phase。

显示内容应来自 workflow spec 和 node state：

- `app_bottom`: workflow title/status、running node、current activity、next controller action。
- `sidebar_content`: workflow spec 摘要、node graph、running/reported/fallback nodes、attention。
- `prompt_progress`: 当前上下文一行状态。
- 主会话灰色 tool result: `sp_status(include_progress=true)` 的按需 `progress_digest`。

fallback summary 必须在 `sidebar_content` 和 `sp_status` 中明显可见。

## 14. Acceptance Scenarios

1. controller 生成包含 3 个 node 的 workflow spec，`sp_prepare(mode="register_workflow")` 校验并写入 draft。
2. 用户批准后，`sp_start(approve_workflow)` 派发第一个 runnable node。
3. node agent 调用 `sp_report(status="passed")` 后，插件按 workflow spec edge 派发下一个 node。
4. node agent 调用 `sp_report(status="failed")` 后，如果 spec 有 retry edge，插件按 retry edge 执行；否则返回 controller decision。
5. node agent 调用 `sp_report(status="needs_user")` 后，插件进入 waiting_user，并通知 controller 主会话询问用户。
6. child session idle 但没有调用 `sp_report` 时，插件生成 fallback summary result，并进入 waiting_controller_decision。
7. fallback summary result 不会默认触发下一个 high-risk node。
8. controller 可以选择 retry node、接受 partial result、取消 workflow 或修改 workflow spec。
9. startup recovery 发现 running node 没有 terminal report 时，插件生成或恢复 fallback summary，并反馈 controller。
10. workflow spec 声明 `spec.md` 或 `plan.md` 是 implementation node 的 required input 时，插件必须先在 run 目录下 materialize canonical workflow artifact，并在派发时内联给 implementation node。
11. TUI 能显示动态 node graph，而不是固定 feature/debug 阶段。
12. `sp_status(include_progress=true)` 能显示当前 node progress 和 fallback summary。
13. capability catalog / workflow examples 和 controller registered workflow spec 分开落盘或分开暴露。

## 15. Migration Notes From V4

| V4 concept | V5 replacement |
|---|---|
| fixed workflow kind decides dispatch | controller generated workflow spec decides dispatch |
| `feature/debug/plan-only/...` built-in flows | controller-generated spec plus static workflow examples and agent catalog |
| managed design/planning modes as built-in phases | controller may include designer/planner nodes in workflow spec |
| fixed task-scoped check chain | controller-generated check nodes and edges |
| plugin semantic workflow definition | plugin generic execution engine |
| missing report can stall workflow | no-report fallback summary result |

v5 不移除现有 agents 或 public tools。它改变的是 agents 被选择和排序的方式。

## 16. Open Questions

- fallback summary 是否由插件本地摘要器生成，还是派发一个专用 summarizer agent 生成。
- workflow spec condition 第一版支持哪些 condition kind。
- controller 修改 active workflow spec 时是否需要用户二次确认。
- fallback summary 在何种低风险场景可以被 spec 声明为可自动继续。
- dynamic workflow 是否需要版本化 schema migration。
