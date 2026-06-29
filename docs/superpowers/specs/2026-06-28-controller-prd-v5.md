# Superpowers Controller PRD V5

## 1. Document Info

- Version: v5
- Date: 2026-06-29
- Status: refined PRD draft
- Supersedes: `docs/superpowers/specs/2026-06-27-controller-prd-v4.md`
- Companion design: `docs/superpowers/specs/2026-06-29-controller-philosophy-tool-interaction-design.md`

v5 继承 v4 已确认的边界：public tool surface、controller autonomy、non-blocking dispatch、runtime recovery、`sp_report` result contract、TUI progress 可见性和主会话按需 progress digest。

v5 的变化集中在一点：插件不再把内置 workflow kind 当作主决策来源，也不把“是否生成 workflow”作为核心分叉。controller 使用固定工具协议推进任务：先理解需求，再对每个任务调用 `sp_prepare` 准备执行任务、生成既有 run-local artifacts 和用户确认内容；如果需要 `sp-designer` 参与，designer 也在 prepare 阶段作为头脑风暴/设计协作者运行。用户确认后，controller 调用 `sp_start`，用参数指定内置 workflow 代号、自定义 workflow 编排或单节点编排。

```text
controller intake 问清用户侧问题
controller 判断 prepare 阶段是否需要 sp-designer 参与
controller 调用 sp_prepare 生成既有任务 artifacts 和确认内容
user confirms prepared execution task
controller 调用 sp_start，传入 built-in workflow id 或 workflow orchestration
plugin 校验并执行启动配置
node agent 执行单个 node 并调用 sp_report
agent report 可产生新任务或 workflow expansion
plugin 根据 state + workflow-spec + result + auto expansion policy 推进或反馈 controller
```

## 2. Product Positioning

Superpowers Controller 是一个 controller-driven agent/workflow runtime plugin。

它不是智能 planner。它不理解用户需求，也不替 controller 选择 agent 或设计 workflow。它提供的是确定性的控制能力：

- agent catalog
- built-in workflow templates
- workflow schema
- workflow examples
- task preparation
- 启动配置校验
- run-local artifact 管理
- node session 创建、恢复和取消
- `sp_report` 结果处理
- no-report fallback
- runtime recovery
- TUI 和 progress 可见性

## 3. Actor Responsibilities

### 3.1 Controller: `super-agent`

controller 是主会话里的总控 agent。

职责：

- 理解用户原始需求。
- 在主会话中问清目标、范围、约束、验收标准和确认点。
- 对每个要执行的任务调用 `sp_prepare`，让插件生成任务文档和用户确认内容。
- 根据任务风险判断 prepare 阶段是否需要 `sp-designer` 参与。
- 在用户确认 prepared execution task 后调用 `sp_start`。
- 在 `sp_start` 参数中选择内置 workflow 代号、自定义 workflow 编排或单节点编排。
- 根据内置 workflow 名称或显式参数决定是否允许 report 自动生成后续节点。
- 调用 `sp_status` 获取当前事实和能力目录。
- 调用 `sp_prepare` 准备任务、持久化任务文档并生成用户确认内容。
- 调用 `sp_start` 按已确认任务和启动配置启动、恢复、重试或继续执行。
- 调用 `sp_cancel` 停止 workflow、node 或 session。
- 解释 plugin 返回的 `controller_feedback`，并在需要时向用户确认。

限制：

- 不直接创建 child session。
- 不直接执行 node 工作。
- 不调用 native task tool。
- 不加载业务 skill。
- 不用自然语言记忆覆盖 `sp_status` 返回的 runtime fact。

### 3.2 Plugin Runtime

plugin 是 workflow runtime 和状态事实源。

职责：

- 暴露 public tools。
- 暴露 agent catalog、workflow schema、built-in workflow templates 和静态 workflow examples。
- 生成并持久化任务准备状态和既有 run-local artifacts。
- 在 prepare 阶段按 controller 决策调度 `sp-designer`，并把 designer 输出整理进确认内容。
- 生成面向用户确认的 task confirmation summary。
- 校验 `sp_start` 提交的内置 workflow 代号或 workflow orchestration。
- 持久化 `workflow-spec.json`、`documents.json`、`state.json`、`events.jsonl` 和 node runtime records。
- 生成 node task packet。
- 创建、复用或恢复 child session。
- 读取 run-local workflow artifacts，并内联到 node prompt。
- 收集和校验 `sp_report`。
- 根据 `WorkflowState`、`workflow-spec.json`、node result 和 auto expansion policy 计算下一步。
- 在启动配置允许时，校验并自动应用 agent-generated task graph 或 workflow expansion。
- 处理 no-report fallback、late report、dispatch failure、startup recovery。
- 通过 `controller_feedback`、TUI surface 和 progress digest 反馈 controller。

限制：

- 不根据用户自然语言生成 workflow。
- 不替 controller 选择 designer 是否参与、agent、workflow template 或业务流程。
- 不把 fallback summary 默认当作成功。
- 不让 progress 替代结构化 `sp_report`。

### 3.3 Node Agents

node agent 是 child session 中执行单个 node 的 agent。

职责：

- 读取插件传入的 node task packet。
- 使用分配的 primary skill。
- 执行当前 node 的 scoped task。
- 在完成、失败、阻塞或需要用户输入时调用 `sp_report`。
- 产出 `summary`、`artifacts`、`checks`、`findings`、`question`、`task_graph` 或 workflow expansion。

限制：

- 不创建新的 workflow。
- 不创建 child session。
- 不调用 native question tool。
- 不在 `sp_report` 中提交 `next_action`、`next_suggestion`、`child_session_id`、`reuse_session_id`。
- 不自行搜索 run 目录之外的 `spec.md`、`plan.md`。

## 4. Controller Prompt Principles

`super-agent` prompt 应包含 Superpowers 工作理念、固定工具使用协议、内置 workflow templates 和常用 workflow 示例。templates 和 examples 只帮助 controller 选择或规划，不是固定流程，也不是 plugin 的智能建议。

### 4.1 Operating Principles

controller 应遵守：

- 首次收到用户请求时，先输出一句固定欢迎语：`欢迎使用superpowers主控插件，我将按superpowers工作流程完成您的任务。`
- 用户和项目指令优先。
- 先理解用户侧问题，再进入 prepare。
- 每个执行任务都必须先调用 `sp_prepare`；prepare 用于准备执行任务、生成既有任务 artifacts 和给用户最终确认。
- `sp_prepare` 之后，controller 向用户展示确认内容；用户确认后才调用 `sp_start`。
- controller 判断是否需要 `sp-designer` 参与；如果需要，必须在 `sp_prepare` 阶段触发 designer 头脑风暴/设计，而不是等 `sp_start` 后再启动设计节点。
- `sp_start` 可以接收内置 workflow 代号，也可以接收自定义 workflow 编排；自定义编排允许只有一个节点。
- 是否允许 agent report 自动生成后续节点，默认由内置 workflow 名称约定和 workflow policy 决定：`*-only` 类 workflow 默认不自动扩展，完整执行类 workflow 默认允许 planner/report 合法扩展；显式参数可覆盖默认值。
- 插件内置 workflow templates 可以被 controller 直接选择、裁剪或忽略；plugin 不根据用户请求推荐 template。
- plan 后默认继续执行：planner 产出的 task graph 或 workflow expansion 由 plugin 校验后自动追加并派发。
- 只做设计、只做计划或只跑指定节点时，controller 应优先选择 `design-only`、`plan-only`、`review-only` 等 `*-only` 内置 workflow，或在自定义 orchestration 中关闭 auto expansion。
- design、plan、debug、TDD、verification、finish 都是过程纪律，不是强制阶段。
- controller 控流，node agent 做事，plugin 执行状态机。
- 证据先于完成声明。
- 状态混乱时先 `sp_status` 对齐事实。

### 4.2 Common Workflow Examples

总控 prompt 中应提供这些示例：

```text
Feature with unclear requirements:
intake -> design/spec -> plan/task graph -> auto-expanded implementation tasks -> acceptance -> verification -> code review -> finish

Simple scoped implementation:
intake -> implementation -> verification -> optional review -> finish

Bugfix:
intake/reproduce -> root cause investigation -> repair plan or implementation -> regression verification -> review -> finish

Design-only or plan-only:
prepare may include designer when needed -> design-only or plan-only -> terminal, default no auto expansion

Review-only:
acceptance or code review node -> verification when needed -> controller decision or finish

Parallel investigation:
independent investigator nodes -> synthesis/finish -> controller decision before write actions
```

controller 可以裁剪、重排或省略节点，但需要保证传给 `sp_start` 的每个 node 有清晰输入、输出、报告契约和 transition 条件。plan 后的 implementation、review、verification 节点可以由 planner report 生成，并在 auto expansion policy 允许时自动进入 workflow。

### 4.3 Built-In Workflow Templates

plugin 应内置一组 workflow templates，作为 `sp_status(include_capabilities=true)` 的能力目录返回。templates 是可复制、可裁剪的结构化起点，不是插件根据用户请求生成的建议。

第一版 templates：

- `feature`: prepare 阶段可含 designer；start 后进入 plan/task graph、implementation、acceptance、verification、code-review、finish 的完整链路。
- `bugfix`: reproduce/root-cause、repair、regression verification、review、finish。
- `review`: acceptance 或 code-review，再按需要进入 verification 或 finish。
- `verify-finish`: verification、finish。
- `design-only`: prepare 阶段调用 designer，确认后 terminal 或只运行后续显式设计检查，默认 no auto expansion。
- `plan-only`: planner bounded run，默认 no auto expansion。
- `review-only`: review bounded run，默认 no auto expansion。
- `parallel-investigate`: 多个 independent investigator nodes，最后 synthesis/finish。
- `single-agent`: one-node template，用于直接委派给一个 agent。

template contract：

```ts
type BuiltInWorkflowTemplate = {
  id: string
  title: string
  description: string
  recommended_for: string[]
  default_start_config: StartConfig
  customization_points: string[]
  risk_notes: string[]
}
```

controller 可以：

- 直接选择 template 并填入当前 request/context。
- 裁剪 template 的 nodes、edges、documents、completion policy 或 auto expansion policy。
- 忽略 template，自己传入自定义 workflow orchestration。

plugin 只能返回 templates 和校验结果，不能基于自然语言替 controller 选择某个 template。

### 4.4 Delegation Decision Examples

controller 应先判断任务形态：

| User request shape | Controller choice | Runtime shape |
|---|---|---|
| 只需回答、解释、总结当前信息 | controller 直接回答 | 不调用插件 |
| 单点实现、单点调查、单次 review | 选择一个最合适的 node agent | one-node workflow run |
| 需求、方案或验收不清 | prepare 阶段引入 designer；必要时 start 选择 planner 或完整 workflow | prepare collaboration + one-node 或 small workflow |
| 多步骤实现、需要验证和收尾 | 选择或裁剪内置 workflow template | multi-node workflow run |
| 只做 plan / design / review | 选择 `*-only` 内置 workflow 或关闭 auto expansion 的单节点编排 | bounded run |

无论 runtime shape 是 one-node 还是 multi-node，plugin 都使用同一套状态、artifact、report、fallback、恢复和 TUI progress 机制。

### 4.5 Controller Behavior Rules

controller 的行为规则按任务生命周期分层：

1. First-response rule: 首次收到用户请求时，先输出固定欢迎语，然后进入 intake。欢迎语只在本轮任务首次进入 Superpowers controller 时输出一次，恢复、重试和状态查询不重复输出。
2. Intake rule: 先在主会话问清用户侧问题，包括目标、范围、约束、验收标准、已有上下文、是否允许改代码、是否只做设计/计划/审查。用户侧问题没问清前，不进入 `sp_prepare`。
3. Status rule: 如果存在未完成 workflow、用户询问进度、运行时状态和 controller 记忆不一致，先调用 `sp_status` 对齐事实，再决定后续工具调用。
4. Prepare rule: 每个将由插件执行的任务都调用 `sp_prepare`。controller 负责给出清晰 task brief，并决定 `design_participation.mode` 是 `none`、`brainstorm` 还是 `design`。
5. Designer rule: `sp-designer` 只在 prepare 阶段参与头脑风暴/设计。designer 可以问设计阻塞问题，但用户侧需求澄清应尽量由 controller intake 完成。
6. Confirmation rule: `sp_prepare` 返回的 `confirmation_summary` 要在主会话给用户确认。用户要求修改时，controller 修改 task brief 后重新 `sp_prepare`；用户取消时调用 `sp_cancel` 或放弃该 prepared task。
7. Start rule: 用户确认后才调用 `sp_start(action="start_prepared_task")`。`sp_start` 只表达启动配置，可以是内置 workflow id，也可以是自定义 orchestration；orchestration 可以只有一个 node。
8. Expansion rule: 优先用内置 workflow 名称表达边界。`design-only`、`plan-only`、`review-only` 等 `*-only` 默认不自动扩展；`feature`、`bugfix` 等完整执行 workflow 默认允许 planner/report 在 guard 内自动扩展。需要偏离默认值时再传显式 override。
9. Native child-session display rule: 插件创建的 node session 必须使用 OpenCode 原生 child session 机制，详细执行过程留在 child session timeline；主会话只展示确认、摘要、入口、关键 attention 和 `sp_status(include_progress=true)` digest，不镜像 child session 的全部 message parts。
10. Monitor rule: 运行中用 `sp_status(include_progress=true)`、OpenCode 原生 child session timeline 或 TUI progress 看事实，不用自然语言猜测 node 是否完成。
11. User input rule: node `needs_user` 时，controller 在主会话问用户；拿到答案后用 `sp_start(resume_input)` 恢复原 child session，不新建替代节点。
12. Fallback rule: child session 没有 terminal `sp_report` 时，fallback summary 只能算部分证据。controller 根据风险选择 retry、inspect、接受 partial、重新 prepare/start 或 cancel。
13. Cancel rule: 用户要求停止、任务边界错误、状态无法安全判断或旧 attempt 被取代时，用 `sp_cancel` 写入取消事实，不能只在自然语言里说停止。
14. Completion rule: 完成声明必须基于 `sp_report`、checks、artifacts 或验证 evidence。progress digest 和 fallback summary 不能单独作为成功依据。

## 5. Public Tool Surface

v5 仍只暴露五个 public tools：

```text
sp_status
sp_prepare
sp_start
sp_cancel
sp_report
```

### 5.1 `sp_status`

定位：只读事实查询。

调用场景：

- 新请求开始时，对齐是否已有 active/draft/waiting workflow。
- 用户询问当前进度。
- controller 状态记忆与 runtime 返回不一致。
- 重启恢复、blocked、fallback、waiting_user 后需要判断下一步。
- controller 需要 agent catalog、workflow schema、built-in workflow templates 或常用 workflow examples。

行为：

- 不修改状态。
- 返回当前 workflow、node 状态、最近 report/fallback、可运行 node、阻塞原因、`controller_feedback`。
- `include_progress=true` 时返回按需 `progress_digest`。
- `include_capabilities=true` 时返回 agent catalog、schema capability、built-in workflow templates 和 workflow examples。

### 5.2 `sp_prepare`

定位：任务准备、任务文档持久化和用户最终确认。

每个要交给插件执行的任务都必须先经过 `sp_prepare`。`sp_prepare` 用于把 controller 已经澄清好的任务整理成执行前上下文，生成或更新既有 run-local artifacts，并返回给主控一份可以展示给用户确认的摘要。controller 判断是否需要 `sp-designer` 参与；如果需要，designer 在 prepare 阶段作为头脑风暴/设计协作者运行，输出进入 `spec.md` candidate 或确认摘要，而不是等 `sp_start` 后再作为执行节点启动。

输入：

```ts
type SpPrepareInput = {
  request: string
  task_brief: {
    goal: string
    scope: string[]
    constraints: string[]
    acceptance_criteria: string[]
    known_context?: string[]
    risks?: string[]
    controller_notes?: string
  }
  design_participation?: {
    mode: "none" | "brainstorm" | "design"
    reason?: string
    blocking_questions_allowed?: boolean
  }
  confirmation: {
    required: boolean
    reason?: string
    question?: string
  }
}
```

返回：

```ts
type PrepareResult = {
  prepared_task_id: string
  status: "prepared" | "needs_revision" | "blocked"
  artifact_paths: {
    request: string
    spec_candidate?: string
    documents: string
    state: string
    events: string
  }
  designer_participation?: {
    status: "not_requested" | "completed" | "blocked"
    summary?: string
    questions?: string[]
  }
  confirmation_summary: string
  required_user_confirmations: string[]
  warnings: string[]
  recommended_next: "confirm_task" | "revise_task" | "cancel_task"
}
```

行为：

- 校验 task brief 是否包含 goal、scope、constraints 和 acceptance criteria。
- 把准备状态写入 `state.json`，把审计事件写入 `events.jsonl`。
- 写入或更新 `request.md`、`documents.json`；需要 designer 参与时，调度 `sp-designer` 并把输出保存为 `spec.md` candidate 或 node record。
- 返回面向用户确认的 `confirmation_summary`。
- 可按 controller 明确请求创建 prepare-phase designer child session；除此之外不派发执行节点。
- 不替 controller 决定 designer 是否参与。
- 不选择内置 workflow。
- 不校验最终 workflow 编排；该校验在 `sp_start` 发生。

### 5.3 `sp_start`

定位：基于已确认的 prepare 结果激活、恢复、重试或继续 execution。

启动输入：

```ts
type SpStartInput =
  | {
      action: "start_prepared_task"
      prepared_task_id: string
      expected_state_version?: number
      start_config: StartConfig
    }
  | {
      action: "resume_input"
      prepared_task_id: string
      resume_input: string
      expected_state_version?: number
    }
  | {
      action: "retry" | "continue" | "inspect"
      prepared_task_id: string
      node_id?: string
      expected_state_version?: number
    }

type StartConfig =
  | BuiltInWorkflowStartConfig
  | CustomOrchestrationStartConfig

type BuiltInWorkflowStartConfig = {
  kind: "built_in_workflow"
  workflow_id:
    | "feature"
    | "bugfix"
    | "review"
    | "verify-finish"
    | "design-only"
    | "plan-only"
    | "review-only"
    | "parallel-investigate"
    | "single-agent"
  overrides?: Partial<WorkflowOrchestration>
  auto_expansion?: AutoExpansionOverride
}

type CustomOrchestrationStartConfig = {
  kind: "orchestration"
  orchestration: WorkflowOrchestration
  auto_expansion?: AutoExpansionOverride
}

type AutoExpansionOverride = {
  allow: boolean
  reason?: string
}
```

行为：

- `start_prepared_task`: 校验 prepare 结果已确认，校验启动配置，激活 execution，派发 initial runnable node。
- `built_in_workflow`: 从内置 workflow template 实例化 workflow，再应用 overrides。
- `orchestration`: 使用 controller 传入的自定义 workflow 编排；编排允许只有一个 node。
- auto expansion 默认规则：内置 workflow id 以 `-only` 结尾时默认 `allow=false`；其它完整执行 workflow 默认 `allow=true`；自定义 orchestration 默认 `allow=false`，除非显式开启。
- `active + running node`: 返回 wait，不重复派发。
- `waiting_user + resume_input`: 清空 pending question，恢复原 child session。
- `waiting_controller_decision`: 按 controller 明确选择继续。
- `fallback_summary_ready`: 默认返回 controller decision，除非 spec 明确允许自动继续。
- `recovered_unknown`: 要求 controller 选择 retry、cancel 或 inspect。
- `expansion_ready`: 如果 auto expansion policy 允许，且 expansion 由已允许的 node 产生并校验通过，自动应用并派发新 runnable node；不回到 controller。

`sp_start` 调度 child prompt 后返回，不等待 child session 完整跑完。

### 5.4 `sp_report`

定位：node result 进入 runtime 的唯一结构化入口。

输入：

```ts
type SpReportInput = {
  node_id?: string
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
  task_graph?: {
    tasks: Array<{
      id: string
      title: string
      summary: string
      agent?: AgentName
      depends_on: string[]
      files?: string[]
      test_commands?: string[]
    }>
  }
  workflow_expansion?: WorkflowExpansionPatch
}
```

禁止字段：

- `next_action`
- `next_suggestion`
- `child_session_id`
- `reuse_session_id`
- `create_sessions`
- `skills_used`

status 语义：

| Status | Runtime effect | Dispatch effect |
|---|---|---|
| `progress` | 更新 record、artifact candidate、progress 和 `reported_at`。node 仍 running。 | 不派发下游。 |
| `passed` | 关闭 node，校验 artifacts/gates/report contract；如果包含 task graph 或 workflow expansion，则按 workflow auto expansion policy 校验并追加。 | expansion 合法时自动派发新增 runnable node；否则按 workflow edge 推进。 |
| `failed` | 关闭 node，记录失败。 | 有明确 failure edge 才继续，否则返回 controller decision。 |
| `blocked` | 标记 node/workflow blocked。 | 不自动继续，反馈 controller。 |
| `needs_user` | 写入 `pending_question`，workflow 进入 `waiting_user`。 | 通知 parent controller session，等待 `sp_start(resume_input)`。 |

### 5.5 `sp_cancel`

定位：显式取消 workflow、node 或 session。

行为：

- 写入取消状态、原因和 state version。
- 对 canceled/interrupted/dispatch_failed node 的 late report 只作为审计，不覆盖 current state。
- 取消后恢复必须读取当前 state、`workflow-spec.json` 和 events，不能回到固定 entrypoint。

## 6. Prepare State And Start Config

v5 的主协议拆成两层：

- prepare state: 存在 `state.json` / `events.jsonl` 中，用于记录任务准备、确认状态和 prepare-phase designer 参与结果。
- `StartConfig`: `sp_start` 参数，用于声明启动方式和调度边界；它不是新文档文件名。

这避免把“任务确认”“任务文档生成”“workflow 编排”混成一个对象。controller 先准备任务，再选择启动计划。

```ts
type PrepareState = {
  version: "v5"
  prepared_task_id: string
  goal: string
  scope: string[]
  constraints: string[]
  acceptance_criteria: string[]
  known_context?: string[]
  risks?: string[]
  confirmation_summary: string
  status: "prepared" | "confirmed" | "revision_requested" | "cancelled"
  designer_participation?: {
    mode: "brainstorm" | "design"
    status: "completed" | "blocked"
    artifact_id?: "spec"
  }
  documents?: WorkflowDocumentSpec[]
}

type StartConfig =
  | BuiltInWorkflowStartConfig
  | CustomOrchestrationStartConfig

type BuiltInWorkflowStartConfig = {
  kind: "built_in_workflow"
  workflow_id: BuiltInWorkflowId
  overrides?: Partial<WorkflowOrchestration>
  auto_expansion?: AutoExpansionOverride
}

type CustomOrchestrationStartConfig = {
  kind: "orchestration"
  orchestration: WorkflowOrchestration
  auto_expansion?: AutoExpansionOverride
}

type BuiltInWorkflowId =
  | "feature"
  | "bugfix"
  | "review"
  | "verify-finish"
  | "design-only"
  | "plan-only"
  | "review-only"
  | "parallel-investigate"
  | "single-agent"

type WorkflowOrchestration = {
  nodes: WorkflowNodeSpec[]
  edges?: WorkflowEdgeSpec[]
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
  kind: "workflow_artifact"
  path: string
  producer_node_id: string
  consumer_node_ids?: string[]
  promotion: "on_node_passed" | "on_controller_approval" | "on_workflow_finish" | "none"
  required: boolean
}

type WorkflowEdgeSpec = {
  from: string
  to: string
  condition:
    | { kind: "on_status"; status: "passed" | "failed" | "blocked" | "needs_user" }
    | { kind: "on_artifact"; artifact: string }
    | { kind: "on_gate"; gate: string }
    | { kind: "controller_decision"; options: string[] }
    | { kind: "fallback_summary"; options: string[] }
}

type AutoExpansionPolicy = {
  enabled: boolean
  allowed_source_nodes?: string[]
  allowed_target_agents?: AgentName[]
  default_task_agent?: AgentName
  max_added_nodes?: number
  max_expansion_depth?: number
  default_check_chain?: Array<"acceptance" | "verification" | "code_review">
}

type AutoExpansionOverride = {
  allow: boolean
  reason?: string
}

type WorkflowExpansionPatch = {
  nodes?: WorkflowNodeSpec[]
  edges?: WorkflowEdgeSpec[]
  documents?: WorkflowDocumentSpec[]
  completion_policy_patch?: Partial<CompletionPolicy>
}
```

结构规则：

- `sp_prepare` 只更新 prepare state 和既有 artifacts，不生成新的 prepare 专用文档名。
- `PrepareState.status="confirmed"` 后才能 `sp_start(action="start_prepared_task")`。
- `sp_start` 必须携带 `StartConfig`。
- `StartConfig.kind="built_in_workflow"` 时，`workflow_id` 必须存在于 built-in workflow templates。
- `StartConfig.kind="orchestration"` 时，`orchestration.nodes` 可以只有一个 node。
- `nodes[].id` 唯一。
- `node.agent` 必须存在于 agent catalog。
- 每个 node 必须有 `report_contract`。
- `nodes[].consumes` 和 `nodes[].produces` 只能引用 `documents[].id`。
- `documents[].path` 相对 `.opencode/superpowers/runs/<run-id>/`。
- auto expansion policy 由 `workflow_id` 默认值、`StartConfig.auto_expansion` 覆盖值和 workflow orchestration guard 合并得出。
- `workflow_id` 以 `-only` 结尾时默认 no auto expansion，例如 `design-only`、`plan-only`、`review-only`。
- auto expansion policy 允许时，被授权 node 的 `sp_report` 可以追加 task graph 或 workflow expansion，并在校验后继续执行。
- auto expansion policy 禁止时，plugin 只运行启动配置中已有 node；node report 中的 task graph 或 expansion 只作为 artifact 保存，不追加执行节点。
- `workflow_expansion` 是首选可执行扩展协议，因为它显式给出 nodes、edges 和 documents。
- 只有当 `task_graph.tasks[].agent` 或 auto expansion policy 的 `default_task_agent` 能确定目标 agent 时，plugin 才能把 `task_graph` 确定性转换为 executable nodes；否则返回 controller decision。
- `default_check_chain` 只做确定性追加，例如为每个 implementation task 追加 acceptance、verification 或 code-review node；插件不根据任务语义自行选择 check 类型。
- edge 只能引用存在的 node。
- graph 第一版按 DAG 处理；retry 通过新 attempt 或新 node run 记录。
- 没有入边的 node 是 initial runnable node。
- completion policy 必须说明 workflow 何时 passed、failed、blocked 或等待 controller。

## 7. Run-Local Artifact Lifecycle

v5 的 document contract 只描述插件控制的 run-local workflow artifacts。

### 7.1 Runtime Control Files

这些文件服务状态、恢复和审计：

```text
.opencode/superpowers/runs/<run-id>/
  documents.json
  state.json
  events.jsonl
  workflow-spec.json
  nodes/<node-id>/task.md
  nodes/<node-id>/record.json
  nodes/<node-id>/fallback-summary.json
  nodes/<node-id>/progress.jsonl
```

### 7.2 Workflow Artifacts

这些文件是 node 之间传递的上下文：

```text
.opencode/superpowers/runs/<run-id>/
  request.md
  spec.md
  plan.md
  task_graph.json
  tasks.json
  reports/<task-id>/task.md
  reports/<task-id>/report.md
  reports/<task-id>/acceptance.md
  reports/<task-id>/verification.md
  reports/<task-id>/code_review.md
  reports/<task-id>/finish.md
```

生成和消费规则：

1. `sp_prepare` 写入或更新 `request.md`、`documents.json`、`state.json` 和 `events.jsonl`；需要 designer 参与时，designer 输出进入 `spec.md` candidate 或 node record。
2. 用户确认 prepared execution task 后，`sp_start(start_prepared_task)` 把内置 workflow 或自定义 orchestration 规范化为 `workflow-spec.json`，并在 `state.json` 中记录启动配置和 auto expansion policy。
3. `sp_start` 派发 node 前生成 `nodes/<node-id>/task.md`；有 `task_id` 时生成 `reports/<task-id>/task.md`。
4. prepare-phase designer 或 start 后 planner 等 node 通过 `sp_report.artifacts` 提交 `spec`、`plan`、`task_graph` 等 candidate。
5. plugin 把 candidate 写入 run 目录的 node record 或 output。
6. workflow orchestration 声明的 promotion 条件满足后，plugin materialize canonical artifact，例如 `spec.md`、`plan.md`、`task_graph.json`、`tasks.json`。
7. 后续 node 派发前，plugin 读取允许消费且已经 canonical 的 workflow artifacts，内联进 node prompt。
8. node 不自行搜索 run 目录之外的 `spec.md` 或 `plan.md`。
9. `sp_report(status="progress")` 只能产生 candidate/progress，不解锁下游。

## 8. Plugin And LLM Interaction Model

### 8.1 Configuration-Time Interaction

OpenCode 加载 plugin 时：

1. plugin 注入 `super-agent`。
2. plugin 注入 `sp-*` node agents。
3. plugin 注入 public tools。
4. plugin 设置权限边界：controller 禁止 native task 和业务 skill；node agent 禁止 native task/question，只允许指定 primary skill。
5. plugin 可以把 active workflow summary 注入 runtime context，但不能把 progress 当作长期 prompt 上下文。

### 8.2 Main Session Interaction

主会话中的模型是 controller。

```text
user request
-> super-agent intake
-> sp_status
-> optional sp_status(include_capabilities=true)
-> super-agent calls sp_prepare with clarified task brief and optional design participation
-> plugin writes existing run-local artifacts and confirmation summary
-> super-agent asks user to confirm prepared execution task
-> user confirms
-> super-agent calls sp_start with built-in workflow id or custom orchestration
```

分工：

- 大模型理解需求、判断 prepare 阶段是否需要 designer、选择内置 workflow 或自定义编排、解释反馈。
- plugin 返回事实、agent catalog、built-in workflow templates、schema、prepare state、启动配置校验结果和下一步控制建议。
- 用户确认发生在主会话。
- child session 创建只由 plugin 完成。

### 8.3 Child Session Interaction

plugin 派发 node 时：

```text
workflow transition
-> build node task packet
-> read canonical workflow artifacts
-> session.create or reuse session
-> register node_run
-> session.prompt(node prompt)
-> node agent executes scoped task
-> node agent calls sp_report
```

node prompt 包含：

- node id
- agent role
- primary skill
- scoped task
- expected output
- report contract
- source artifacts inline content
- allowed `sp_report` shape

### 8.4 Report-Driven Transition And Expansion

node agent 调用 `sp_report` 后：

```text
sp_report
-> parse and validate schema
-> match node_run by node_id/session_id
-> write record and artifacts
-> update workflow state
-> if task_graph/workflow_expansion exists and workflow policy allows auto expansion, validate and append nodes/edges/documents
-> compute transition from state + workflow-spec + node result
-> dispatch next node or return controller_feedback
```

如果 `workflow_expansion` 合法，plugin 自动追加新 nodes/edges/documents，并重新计算 runnable nodes。

如果 report 只有 `task_graph`，plugin 只能按 deterministic expansion rule 转换：每个 task 变成一个 node，agent 来自 `task.agent` 或 auto expansion policy 的 `default_task_agent`，依赖关系变成 edges，`default_check_chain` 变成附加检查节点。任何 agent、edge、document、数量或深度校验失败，都不能靠插件猜测补齐。

planner passed 后的 implementation、acceptance、verification、code-review、finish 节点应走这条路径继续执行，不默认回到 controller。

如果 transition 明确、agent 存在、artifact 已 canonical、没有用户输入和 controller decision edge，plugin 可以自动派发下一 node。

如果 auto expansion policy 禁止扩展，plugin 不应用 report 中的新任务，只按 `workflow-spec.json` 的 completion policy 结束或继续已有节点。transition 不明确、缺 artifact、fallback summary、权限不可用、校验失败或有高风险动作时，plugin 返回 controller decision 或 blocked。

### 8.5 User Input Bridge

node 需要用户输入时：

```text
node agent
-> sp_report(status="needs_user", question=...)
-> plugin writes pending_question
-> plugin notifies parent controller session
-> super-agent asks user
-> user answers
-> super-agent calls sp_start(resume_input)
-> plugin resumes original child session
```

node agent 不调用 native question tool。用户输入回到主会话，再由 plugin 恢复原 child session。

### 8.6 No-Report Fallback

如果 child session 没有 terminal `sp_report`：

```text
detect idle/error/stalled/recovered node without terminal report
-> collect transcript/progress/tool/error evidence
-> create FallbackSummaryResult
-> write nodes/<node-id>/fallback-summary.json
-> mark waiting_controller_decision
-> expose via sp_status/controller_feedback/TUI
```

fallback summary 是部分证据。默认不能驱动成功路径。

## 9. Runtime Decision Model

plugin 每次只根据四类输入计算下一步：

1. 当前 `WorkflowState`。
2. `state.json` 中的 prepare/confirmation/start configuration，以及 `workflow-spec.json`。
3. 最新 node result: `sp_report` 或 fallback summary。
4. workflow auto expansion policy 以及 report 中的 `task_graph` / `workflow_expansion`。

transition 输出只能是：

- `create_session`
- `reuse_session`
- `wait_user`
- `wait_controller`
- `finish`
- `blocked`

自动推进条件：

- report status 与 edge condition 明确匹配。
- 下一个 node agent 存在。
- node 所需 artifacts 已 canonical。
- agent-generated expansion 通过 schema、agent、edge、artifact 和 workflow auto expansion policy 校验。
- `task_graph` 能通过 deterministic expansion rule 转成可执行 node graph。
- 没有 controller decision edge。
- 没有 unresolved user input。
- 没有未确认的高风险副作用。

返回 controller 条件：

- 多条 edge 同时匹配且优先级不明确。
- fallback summary 代替了 terminal report。
- auto expansion policy 禁止扩展，但 workflow completion policy 没有说明如何处理 report 中的新任务。
- agent-generated expansion 校验失败。
- report 与 spec condition 不匹配。
- report 缺少 required artifact。
- agent 不存在或权限不可用。
- prepare state、启动配置或 `workflow-spec.json` 不完整。
- startup recovery 后状态不能安全判断。

## 10. Progress And TUI

progress 是用户可见性，不是状态机输入。

显示原则：

- 详细过程优先使用 OpenCode 原生 child session 展示。插件通过 `session.create(parentID)` 创建 node child session，用户可以进入 child session 查看完整 timeline、tool call、patch 和 reasoning。
- 主会话区域不镜像 child session 的完整 message parts，只展示 `sp_prepare` / `sp_start` / `sp_status` 的确认、摘要、入口和 progress digest。
- `app_bottom`: workflow title/status、running node、current activity、next controller action。
- `sidebar_content`: prepared execution task、workflow-spec、node graph、running/reported/fallback nodes、attention。
- `prompt_progress`: 当前上下文一行状态。
- 主会话灰色 tool result: `sp_status(include_progress=true)` 的按需 `progress_digest`。

progress 不能替代：

- `node_runs`
- `sp_report`
- workflow edge
- completion policy
- fallback policy

## 11. Persistence And Recovery

持久化要求：

- `sp_prepare` 后，任务准备、确认状态和 prepare-phase designer 结果必须写入 `state.json` / `events.jsonl`。
- `sp_start(start_prepared_task)` 后，启动配置、内置 workflow 展开结果、自定义 orchestration 和 auto expansion policy 必须写入 `state.json` 与 `workflow-spec.json`。
- `workflow-spec.json` 是规范化后的 workflow graph snapshot。
- `documents.json` 记录 run-local artifact id、path、producer、consumer、candidate/canonical 状态和 promotion event。
- `state.json` 是 durable snapshot。
- `events.jsonl` 是审计日志。
- node task、record、fallback summary、progress 都按 node id 落盘。

恢复规则：

- runtime memory 是当前事实源。
- durable snapshot 用于重启恢复和审计。
- 启动时遗留 running node 不能直接视为 live；需要 reconciliation。
- recovered workflow 默认进入 controller decision，而不是自动重派发。
- late report 不覆盖 newer attempt 或 canceled/interrupted node。
- `sp_status` 必须给 controller 明确 next decision。

## 12. Abnormal Scenario Behavior Matrix

v5 的异常处理原则是：plugin 保留事实和状态机，controller 保留自主决策权。插件不能替 controller 理解用户意图，但必须把当前事实、阻塞原因、可选动作和风险通过 `controller_feedback` / `sp_status` 明确返回。

| 场景 | 插件行为 | controller 行为 | 是否可继续 |
|---|---|---|---|
| 系统重启时有 running node | 启动恢复读取 `state.json` / `events.jsonl` / `node_runs`，不假设旧 child session 仍 live；把无法确认的 running node 标为 interrupted 或进入 `recovered_unknown`。 | 先调用 `sp_status`，根据 `controller_feedback` 选择 inspect、retry interrupted node、cancel 或重新 prepare/start。 | 可继续，但默认需要 controller 决策。 |
| 重启前 child session 已完成但未写 terminal `sp_report` | 插件检测到无 terminal report，收集 transcript/progress/tool/error evidence，生成 `fallback-summary.json`，进入 `waiting_controller_decision`。 | 判断 fallback 是否足够作为 partial evidence；高风险任务应 retry/inspect，低风险只读任务可接受 partial。 | 可继续，但 fallback 不默认成功。 |
| prepare-phase designer 被中断 | prepare state 保留 designer node/session、candidate artifact 和 pending status；重启后进入 prepare decision。 | controller 可恢复 designer、重新 `sp_prepare`、跳过 designer 或取消。用户侧需求不清时优先补澄清再恢复。 | 可继续，仍停留 prepare 阶段。 |
| planner 被中断 | 保留 planner node_run 和已有 candidate `plan.md` / `task_graph.json`；未 passed 时不 promotion，不自动扩展执行节点。 | controller 选择 retry planner、inspect candidate、改为 `plan-only` 收束，或重新 prepare/start。 | 可继续，但不会自动执行未确认 task graph。 |
| implementer / reviewer / verifier 执行失败 | `sp_report(status="failed")` 关闭当前 node；只有 workflow 有明确 failure edge 时自动推进，否则进入 controller decision。 | controller 根据失败类型选择 retry、复用原 implementer session、派发调查/修复节点、修改 workflow 或 cancel。 | 可继续，失败不会变成死循环。 |
| node `needs_user` | 写入 `pending_question`，workflow 进入 `waiting_user`，通知 parent controller session。 | 在主会话问用户；拿到回答后恢复原 child session，不创建新 node。 | 可继续，等待用户输入期间不会自动推进。 |
| child session 长时间无 progress | progress layer 标记 stalled；状态机不因此自动失败。 | controller 可查看 child session 原生 timeline，或调用 `sp_status(include_progress=true)` 后选择 wait、inspect、cancel、retry。 | 可继续，默认不自动重派发。 |
| child session 没有调用 `sp_report` | 插件生成 fallback summary 并进入 decision，不把自然语言完成当作成功。 | controller 根据证据选择 retry、accept partial、revise workflow 或 cancel。 | 可继续，需 controller 决策。 |
| report-driven expansion 校验失败 | 保存 report/artifact，记录 schema/agent/edge/document/数量/深度错误，不追加节点。 | controller 可要求 planner 修正、手动给 `sp_start` 新 orchestration、关闭 auto expansion 或取消。 | 可继续，但不靠插件猜测补齐。 |
| required artifact 缺失或未 canonical | transition 返回 blocked / controller decision，不让 node 自行搜索 run 目录外文件。 | controller 可恢复 producer node、批准 candidate、重新生成 artifact 或裁剪 workflow。 | 可继续，前提是补齐文档 contract。 |
| late report 到达 | 如果 node 已 canceled/superseded 或 newer attempt 已存在，late report 只做审计，不覆盖 current state。 | controller 可查看 late evidence，但继续以最新 attempt 为准。 | 可继续，避免旧结果回滚状态。 |
| 用户取消任务 | `sp_cancel` 写入 canceled 状态、原因、scope 和 state version；底层 child session 无法强杀时也标记 superseded。 | controller 告知取消结果；后续如需继续必须重新 prepare/start 或显式 retry。 | 不自动继续。 |
| 状态与主控记忆不一致 | `sp_status` 返回 runtime fact、durable note、recommended_next 和 attention。 | controller 以 `sp_status` 为准，不用自然语言记忆覆盖 runtime fact。 | 可继续，先对齐事实。 |

这些场景都不要求 plugin 具备语义智能。plugin 负责把状态闭合到 finite decision point；controller 根据用户目标和当前证据选择下一步。只要 `sp_status` 能返回明确 `recommended_next`，任务就不会卡在无解释状态；只要失败和无报告都不会自动视为成功，任务也不会跑偏到错误完成。

## 13. Acceptance Scenarios

1. controller 能读取 agent catalog、schema、built-in workflow templates 和 workflow examples。
2. 每个交给插件执行的任务都先调用 `sp_prepare`。
3. `sp_prepare` 写入或更新 `request.md`、`documents.json`、`state.json` 和 `events.jsonl`；除 prepare-phase designer 外，不派发执行 child session。
4. `sp_prepare` 返回 `confirmation_summary` 和 `required_user_confirmations`，供 controller 在主会话向用户确认。
5. 用户确认 prepared execution task 后，controller 调用 `sp_start(action="start_prepared_task")`。
6. `sp_start` 可接收 `start_config.kind="built_in_workflow"` 和内置 workflow 代号。
7. `sp_start` 可接收 `start_config.kind="orchestration"` 和自定义 workflow 编排。
8. 自定义 workflow 编排允许只有一个 node。
9. controller 可在 `sp_prepare` 参数中决定是否让 `sp-designer` 参与 prepare-phase brainstorming/design。
10. `design-only`、`plan-only`、`review-only` 等 `*-only` 内置 workflow 默认不自动扩展。
11. auto expansion policy 禁止扩展时，plugin 不应用 planner 产出的 task graph 或 workflow expansion，只保存为 artifact。
12. auto expansion policy 允许且 expansion 合法时，plugin 自动把任务扩展成 execution/check/finish nodes 并继续派发。
13. `sp_report(status="progress")` 不派发下游。
14. `sp_report(status="failed")` 只有在 workflow 有明确 failure edge 时自动推进。
15. `sp_report(status="needs_user")` 写入 pending question，并通知 parent controller session。
16. `sp_start(resume_input)` 恢复原 child session，不创建新 node。
17. child session 无 terminal report 时生成 fallback summary，并进入 controller decision。
18. `spec.md`、`plan.md` 等 workflow artifacts 只从 run 目录读取并内联给 node agent。
19. TUI 能展示 prepared execution task、workflow-spec、动态 node graph、fallback、attention 和 progress digest。
20. startup recovery 不把 durable running 当成 live running。
21. public tool surface 不新增工具，仍是 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
22. controller 首次进入 Superpowers 工作流时输出固定欢迎语。
23. 详细执行过程使用 OpenCode 原生 child session 展示；主会话只显示确认、摘要、入口、attention 和按需 progress digest。

## 14. Migration Notes From V4

| V4 concept | V5 replacement |
|---|---|
| fixed workflow kind decides dispatch | confirmed prepare state plus controller-selected start config decides dispatch |
| built-in feature/debug/review flows | built-in templates plus controller-provided start config |
| managed design/planning modes | controller may involve designer during prepare; planner may expand execution nodes |
| fixed task-scoped check chain | auto expansion policy and planner-generated nodes/checks |
| plugin semantic workflow definition | plugin generic execution engine |
| missing report can stall workflow | no-report fallback summary result |

v5 不移除现有 agents 或 public tools。它改变的是 agents 被选择和排序的方式。

## 15. Open Questions

- fallback summary 第一版由插件本地摘要逻辑生成，还是派发专用 summarizer node 生成。
- workflow condition 第一版支持哪些 condition kind 的完整枚举。
- auto expansion policy 第一版如何限制最大节点数、允许 agent、默认 check chain 和递归扩展深度。
- fallback summary 在哪些低风险场景可以被 spec 声明为可自动继续。
- dynamic workflow schema 是否需要版本化 migration。
