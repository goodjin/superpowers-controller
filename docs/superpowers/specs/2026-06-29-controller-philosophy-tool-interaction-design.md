# Superpowers Controller Philosophy And Tool Interaction Design

## 1. Purpose

本文档补充 `2026-06-28-controller-prd-v5.md`，目标是把 Superpowers 官方技能体现出的工作理念整理成总控 agent prompt 的一部分，并明确 `sp_status`、`sp_prepare`、`sp_start`、`sp_report`、`sp_cancel` 在 v5 prepare/start 工具协议下的调用场景、行为和插件-大模型交互方式。

本文档是设计说明，不代表当前运行时代码已经实现。当前代码仍有 v4 固定流程痕迹，后续实现应以本文和 v5 PRD 共同作为目标。

## 2. Superpowers 设计理念提炼

Superpowers 的核心不是某条固定流程，而是一组工作纪律。controller 应把这些纪律用于澄清任务、准备执行任务、判断 prepare 阶段是否需要 designer 参与，并在用户确认后通过 `sp_start` 选择内置 workflow 代号或自定义编排，而不是把用户需求硬套到 `feature/debug/plan-only` 等固定流程。

### 2.1 用户指令优先

用户的直接要求、项目内 `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`、当前会话约束优先于通用技能规则。controller 不能因为某个推荐流程存在，就覆盖用户明确的范围、语言、确认点、权限和交付要求。

对 execution 规划的影响：

- intake 阶段先确认用户目标、范围、约束、验收标准和已有上下文。
- 用户明确要求“只调查”“先设计”“不要改代码”“不跑测试”等约束时，prepare state 和启动配置必须体现这些限制。
- 当技能规则和项目规则冲突时，controller 应把冲突暴露给用户或按用户侧规则裁剪 agent delegation / workflow。

### 2.2 先理解，再设计，再执行

Superpowers 倾向于在动手前先理解问题、整理设计，再进入实现。这里的“设计”不是固定节点，而是 controller 需要根据任务风险决定是否生成设计节点、计划节点或直接执行节点。

对 execution 规划的影响：

- 目标不清、影响面不清、验收口径不清时，先由 controller 在主会话问清楚。
- 方案不清、边界不清、架构取舍不清时，controller 在 `sp_prepare` 中请求 `sp-designer` 参与头脑风暴/设计。
- 多步骤实现、跨模块修改、需要任务依赖时，controller 在 `sp_start` 中安排 `sp-planner` 或选择包含 planner 的内置 workflow。
- 每个插件执行任务都先经过 `sp_prepare`，由插件生成任务文档和用户确认摘要。
- 启动配置可以是内置 workflow 代号，也可以是自定义 orchestration；自定义 orchestration 可以只有一个节点。
- plan 后的执行任务由 planner 或后续 agent 的 `sp_report` 产出，并在 workflow auto expansion policy 允许时由插件校验后自动扩展。
- 小型、低风险、用户已给出明确实现路径的任务，可以跳过 designer/planner，但仍要有明确的验证或完成条件。

### 2.3 技能是过程纪律，不是流程模板

官方技能表达的是“如何做事”的纪律：

- brainstorming: 先形成设计和约束。
- writing-plans: 把已确认方案拆成可执行任务。
- test-driven-development: 生产行为变更优先红绿重构。
- systematic-debugging: bug 先定位 root cause。
- dispatching-parallel-agents: 只把独立问题域并行化。
- verification-before-completion: 完成声明前要有新鲜证据。
- finishing-a-development-branch: 收尾要检查验证、提交、交付状态。

controller 设计启动配置时应从任务性质选择这些纪律。例如 bugfix 工作不应直接进入 implementer，而应先安排 debugger 或调查节点；完成交付前不应只依赖 implementer 的口头总结，而应安排 verifier 或等价验证节点。

### 2.4 Controller 只控流，不做节点工作

`super-agent` 是总控，不是实现者。它应该理解需求、规划 workflow、解释状态、向用户确认关键点，并通过 public tools 推进运行时。

边界要求：

- controller 不直接编辑代码、不执行节点工作、不加载业务技能。
- controller 可以调用 `sp_prepare` 准备任务，并在用户确认后调用 `sp_start` 提交启动配置，但不直接创建执行 child session。
- child session 只能由插件在 `sp_start` 或 `sp_report` 触发的 transition 中创建或恢复。
- node agent 只能执行当前 node，并通过 `sp_report` 汇报结果。

### 2.5 插件是运行时事实源

模型可以推理和规划，但 prepare state、启动配置、节点运行、恢复、取消、fallback、progress 都应由插件持久化并反馈。插件不具备需求理解智能，不能替 controller 选择 designer、agent 或业务 workflow；它只能暴露 agent catalog、workflow schema、built-in workflow templates、常用 workflow 示例和校验结果。

设计原则：

- `sp_status` 是 controller 对齐事实的入口。
- `state.json`、`workflow-spec.json`、node state、`sp_report`、fallback summary 是 transition 的依据。
- TUI progress 是可见性 side-channel，不能替代 `sp_report`。
- 重启恢复必须读取 durable state，不能靠 prompt 重新猜流程。

### 2.6 证据先于完成声明

任何“完成”“通过”“可交付”的判断都需要来自结构化报告和验证证据，而不是节点自然语言自称完成。

对 workflow 规划的影响：

- 需要代码变更的工作，启动配置应包含测试、构建、审查或验证节点，除非用户明确裁剪。
- `completion_policy` 必须说明哪些 node result、artifact 或 check 可以让 workflow 结束。
- fallback summary 不能默认视为成功。

## 3. Controller Prompt 设计

应在 `super-agent` prompt 中加入一个独立的 Superpowers Operating Principles 区块。该区块要指导 controller 先 prepare，再 start，而不是重复固定 v4 流程。

建议 prompt 文案如下，后续实现可直接改写进 `src/agents/index.ts`：

```text
## Superpowers Operating Principles

You are the workflow controller, not a worker.

When you receive the first user request for a Superpowers-controlled task, say exactly once in Chinese: 欢迎使用superpowers主控插件，我将按superpowers工作流程完成您的任务。

User instructions and project instructions are the highest priority. Before preparing task execution, understand the user's goal, scope, constraints, success criteria, and any existing context. Ask in the main conversation when these user-side inputs are missing.

Every task that will be executed by the plugin must go through sp_prepare first. sp_prepare is for preparing execution, writing existing run-local task artifacts, and final user confirmation. You decide whether sp-designer is needed. If needed, request sp-designer participation during sp_prepare as brainstorming/design work, before sp_start.

After the user confirms the prepared execution task, call sp_start. sp_start receives the actual start configuration. The start configuration may reference a built-in workflow id, or provide a custom workflow orchestration. A custom orchestration may contain only one node. Do not defer designer brainstorming to sp_start.

Plan the start configuration from the nature of the task, not from fixed workflow names. Use Superpowers skills as process disciplines:
- use design/spec work when requirements, architecture, boundaries, or acceptance criteria are unclear;
- use planning work when execution needs multiple ordered tasks or dependency management;
- use debugging/root-cause work before repair when the request is a bug, failure, or unexpected behavior;
- use TDD-oriented implementation for production behavior changes when applicable;
- use parallel investigation only for independent problem domains;
- use verification before completion claims;
- use finishing work only after fresh verification evidence exists.

Common workflow examples are examples, not fixed templates:
- Feature with unclear requirements: intake -> design/spec -> plan/task graph -> auto-expanded implementation tasks -> acceptance -> verification -> code review -> finish.
- Simple scoped implementation: intake -> implementation -> verification -> optional review -> finish.
- Bugfix: intake/reproduce -> root cause investigation -> repair plan or implementation -> regression verification -> review -> finish.
- Design-only or plan-only: prepare may include designer when needed -> design-only or plan-only -> terminal, with no auto expansion by default.
- Review-only: acceptance or code review node -> verification when needed -> controller decision or finish.
- Parallel investigation: independent investigator nodes -> synthesis/finish -> controller decision before write actions.

The plugin exposes built-in workflow templates for convenience. You may choose, adapt, or ignore them. The plugin does not recommend templates from the user's natural language; you make that decision.

Use sp_prepare with a clarified task brief: goal, scope, constraints, acceptance criteria, known context, and risks. Show the returned confirmation_summary to the user and wait for confirmation when required.

Use sp_start with either:
- built_in_workflow: a workflow id such as feature, bugfix, review, verify-finish, plan-only, parallel-investigate, or single-agent, plus optional overrides;
- orchestration: explicit nodes, edges, documents, completion policy, and fallback policy. One node is valid.

Use built-in workflow names to express expansion boundaries when possible. Workflow ids ending with -only, such as design-only, plan-only, or review-only, default to no auto expansion. Full execution workflows such as feature or bugfix default to allowing guarded planner/report expansion. Use an explicit auto_expansion override only when the default is wrong for the current user request.

Do not execute delegated node work yourself. Do not edit files, load business skills, or call the native task tool. Use sp_status to read runtime facts and deterministic capabilities, sp_prepare to prepare and confirm tasks, sp_start to activate/resume/retry with a start configuration, sp_cancel to stop, and rely on node agents to call sp_report.

Use OpenCode native child sessions for detailed node execution visibility. Do not mirror every child message part into the parent conversation. The parent conversation should show confirmations, summaries, entry links or names, attention items, and on-demand progress_digest from sp_status(include_progress=true). Detailed tool calls, patches, reasoning, and text remain in the child session timeline.

When runtime state is confusing, call sp_status and follow controller_feedback. If a node reports needs_user, ask the user in the main conversation and resume the original node with sp_start. If a node has no sp_report and the plugin returns fallback summary, treat it as partial evidence and choose retry, inspect, accept partial, revise workflow, or cancel according to risk.
```

这个 prompt 需要替换当前 v4 风格的固定提示：“For planning-driven work, follow this sequence...”。v5 中 controller 可以采用 design/planning，但不应被固定顺序限制。

## 4. Public Tool 调用场景和行为

### 4.1 `sp_status`

定位：只读事实查询和重新对齐入口。

典型调用场景：

- controller 收到 `/sp` 或用户要求继续、查看、恢复工作时。
- controller 不确定当前是否已有 active/draft/waiting workflow 时。
- 用户问“现在在做什么”“子会话有没有进展”“为什么卡住了”时。
- tool result、TUI、用户描述和 controller 记忆不一致时。
- 重启、恢复、blocked、fallback、waiting_user 后需要决定下一步时。

行为：

- 不修改 workflow state。
- 返回 current workflow、node 状态、最近 report/fallback、可运行节点、阻塞原因、progress digest、controller_feedback 和 allowed tool calls。
- v5 中还可以返回 agent catalog、workflow schema、built-in workflow templates 和常用 workflow 示例。它们是确定性能力说明，不是插件智能规划结果。

插件与大模型交互：

- controller 调用工具后，插件同步返回结构化 JSON。
- 大模型只根据返回值解释状态和选择下一步工具，不应靠自己记忆覆盖 `sp_status`。
- `include_progress=true` 时返回按需进度摘要，可用于主会话灰色 tool result 或用户主动查看，不应长期注入 prompt。

### 4.2 `sp_prepare`

定位：任务准备、任务文档持久化和用户最终确认。

调用场景：

- controller 已经在主会话问清用户目标、范围、约束和验收标准。
- controller 准备把任务交给插件执行。
- 项目规则要求执行前让用户确认任务。
- controller 需要把任务说明持久化成 run-local task document。
- controller 判断需要 `sp-designer` 在 prepare 阶段参与头脑风暴/设计。

行为：

- 输入 request、task brief、confirmation policy，以及可选的 `design_participation`。
- 校验 task brief 是否包含 goal、scope、constraints 和 acceptance criteria。
- 把 prepare state 写入 `state.json`，把审计事件写入 `events.jsonl`。
- 写入或更新 `request.md` 和 `documents.json`。
- 如果 `design_participation.mode` 不是 `none`，调度 `sp-designer` 做 prepare-phase brainstorming/design，并把输出保存为 `spec.md` candidate 或 node record。
- 返回 `prepared_task_id`、`confirmation_summary`、`required_user_confirmations`、warnings 和 recommended_next。
- 除 prepare-phase designer 外，不创建执行 child session。
- 不替 controller 选择 designer 是否参与。
- 不选择内置 workflow。
- 不校验最终 workflow 编排。

插件与大模型交互：

- 插件把 prepare state、artifact 路径和确认摘要返回给 controller。
- controller 在主会话把 `confirmation_summary` 展示给用户。
- 用户要求修改时，controller 重新澄清后再次调用 `sp_prepare`。
- 用户确认后，controller 调用 `sp_start` 并提交启动配置。

### 4.3 `sp_start`

定位：基于已确认 prepare 结果和启动配置激活、恢复、重试、继续执行。

调用场景：

- 用户确认 prepared execution task 后启动。
- controller 已决定使用内置 workflow 代号或自定义 workflow orchestration。
- workflow 等待用户输入，controller 已收集答案，需要恢复原 child session。
- workflow 处于 recovered/blocked/waiting_controller_decision，controller 选择 retry、inspect、accept partial、continue 或 cancel 之外的继续动作。
- 某个 node 已 report，插件反馈需要 controller 明确选择下一步。

行为：

- 校验 prepare state 是否存在且已确认。
- 校验启动配置。
- `built_in_workflow`: 根据 workflow id 实例化内置 template，并应用 overrides。
- `orchestration`: 使用 controller 传入的 nodes、edges、documents、completion policy 和 fallback policy；nodes 允许只有一个。
- 根据 workflow id 默认值和可选 `auto_expansion` override 生成 auto expansion policy；`*-only` 默认禁止自动扩展。
- 激活 workflow 时，计算 initial runnable nodes 并通过 orchestrator 创建或复用 child session。
- resume_input 时消费 pending question，并把回答发回原 node session，不创建新 node。
- retry 时创建新 attempt 或复用允许复用的 session，不能覆盖旧 attempt 的 record。
- 如果已有 running node，不重复派发，返回 wait 和当前状态。
- 如果存在已校验的 report-driven expansion，且 auto expansion policy 允许，插件应用 expansion 并派发新的 runnable node，不要求 controller 重新规划。
- 如果 auto expansion policy 禁止，插件不应用 report 中的新任务，只保存 artifact，并按 `workflow-spec.json` 的 completion policy 结束或继续已有节点。
- 返回 fresh state，而不是 dispatch 前的旧快照。

插件与大模型交互：

- controller 只调用 `sp_start` 表达已确认的启动/恢复/重试控制决策。
- 插件持久化 state，再调用 OpenCode `session.create` / `session.prompt` 后台调度 child session。
- child session 的执行结果不会直接塞回 controller 当前回合；后续由 `sp_report`、progress、parent notification 或下一次 `sp_status` 反馈。

### 4.4 `sp_report`

定位：node agent 把执行结果交回运行时的唯一结构化入口。

调用场景：

- node agent 完成当前任务。
- node agent 遇到失败、阻塞或需要用户输入。
- node agent 做长任务时提交 progress。
- node agent 产出 artifact、check result、finding、task_graph 或 verification evidence。

行为：

- `progress` 只更新节点进度，不触发下游 transition。
- `passed` / `failed` / `blocked` / `needs_user` 写入 terminal 或等待状态。
- `needs_user` 写入 pending_question，并通知 parent controller session。
- `passed` report 中的 `task_graph` 或 `workflow_expansion` 会进入 expansion 校验；policy 允许且校验通过时，插件自动追加 nodes/edges/documents 并继续派发。
- policy 禁止扩展时，`task_graph` 或 `workflow_expansion` 只作为 artifact 或 report evidence 保存，不进入可执行 graph。
- terminal report 进入统一 transition，插件根据 `state.json`、`workflow-spec.json` edge、completion_policy 和 fallback_policy 计算下一步。
- report 不能包含 `next_action`、`next_suggestion`、`child_session_id`、`reuse_session_id` 或其它 control-plane 字段。node agent 的观察只能放进 `summary` 或 `findings`，由 controller 或 workflow policy 决定是否采用。

插件与大模型交互：

- node agent 调用工具后，插件在该 child session 返回 tool result，说明记录和后续调度状态。
- 如果 transition 可以自动推进，插件在后台派发下一个 node。
- 如果 report 产生了合法 expansion，插件先应用 expansion，再重新计算 runnable nodes；planner 完成后不默认回 controller。
- 如果需要 controller decision，插件写 state，并通过 parent notification 或 `sp_status` 暴露给 controller。
- controller 不应要求 node agent 直接创建新 session，也不应接受 report 中自造的 `child_session_id`、`next_action`、`reuse_session_id`。

### 4.5 `sp_cancel`

定位：显式停止 workflow、node 或 session。

调用场景：

- 用户要求停止、取消、放弃当前工作。
- controller 判断 prepare state 或启动配置错误、风险过高、状态混乱且不宜继续。
- 某个 child session 失控、重复失败或已经被新 attempt 取代。
- 恢复后发现旧 session late report 不能安全采用。

行为：

- 按 scope 取消 workflow、node 或 session。
- 写入取消原因、来源和 state version。
- 对 active workflow 返回取消后的 controller_feedback：terminal、可重试、可重新 prepare 或需 inspect。
- 取消后恢复不能回到固定 entrypoint，必须读取当前 dynamic workflow state。

插件与大模型交互：

- controller 调用 `sp_cancel` 后，插件返回最新 state。
- node session 可能无法被底层强杀时，插件也要把该 node 标记为 canceled/superseded，后续 late report 只能作为历史记录或需要 controller 决策。

## 5. 插件如何通过这些方法与大模型交互

### 5.1 配置注入

插件在 OpenCode config 阶段注入：

- `super-agent` 总控 agent。
- `sp-*` node agents。
- public tools: `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- agent permissions: controller 禁止 native task 和业务 skill；node 禁止 native task/question，只允许指定 primary skill。

这一步决定了大模型能看到哪些 agent、工具和权限边界。

### 5.2 主会话控制循环

主会话里的 `super-agent` 只做控制循环：

```text
user request
-> controller intake
-> optional sp_status
-> optional sp_status(include_capabilities=true)
-> controller calls sp_prepare with clarified task brief and optional design participation
-> plugin writes existing run-local artifacts and confirmation summary
-> controller asks user to confirm the prepared execution task
-> user confirms
-> controller calls sp_start with built-in workflow id or custom orchestration
```

这个循环中，大模型负责理解和决策，包括判断 prepare 阶段是否需要 designer、选择内置 workflow 或自定义编排、解释反馈。插件负责暴露能力目录、生成既有任务 artifacts、校验启动配置、落盘和派发。controller 不直接创建执行 session。

### 5.3 子会话执行和扩展循环

插件通过 `sp_start` 或 report transition 创建 child session：

```text
plugin transition
-> build node task packet
-> session.create / session.prompt
-> node agent loads primary skill
-> node work
-> sp_report
-> plugin records result
-> optional expansion validation/application
-> transition or controller feedback
```

node prompt 应包含 scoped task、required context、source artifacts、expected output 和 report_contract。node agent 不应自行搜索 workflow artifact，也不应把 prompt 外的猜测当成状态来源。

当 planner 或其它 node 在 `sp_report` 中返回 `task_graph` 或 `workflow_expansion`：

- `workflow_expansion`：插件校验新增 node、edge、document、agent、artifact 引用、最大节点数和递归深度；通过后追加到当前 workflow，并直接派发新的 runnable node。
- `task_graph`：插件只做确定性转换。每个 task 变成一个 node，agent 来自 task.agent 或 workflow auto expansion policy 的 `default_task_agent`，depends_on 变成 edges，`default_check_chain` 变成附加检查节点。缺少 agent、超出 allowed_target_agents、超出数量或深度限制时，不猜测补齐。
- auto expansion policy 禁止：插件保存 report 和 artifact，但不把新增任务加入 workflow。该模式用于 `design-only`、`plan-only`、`review-only` 或只跑指定节点等场景。
- expansion 校验失败：插件把失败原因写入 controller_feedback，workflow 进入需要 controller 决策或 blocked 状态。

### 5.4 等待用户输入

当 node agent 需要用户输入：

```text
node agent -> sp_report(status="needs_user", question=...)
plugin writes pending_question
plugin notifies parent controller session
super-agent asks user in main conversation
user answers
super-agent -> sp_start(resume_input)
plugin resumes original child session
```

这个机制保证用户问题回到主会话，且原 child session 可以恢复上下文，不需要创建一个脱离 state 的新 session。

### 5.5 无 `sp_report` 的 fallback

如果 child session 没有调用 `sp_report`：

```text
plugin detects idle/error/stalled/recovered running node without terminal report
-> collect transcript/progress/tool/error evidence
-> generate FallbackSummaryResult
-> write fallback-summary.json
-> mark waiting_controller_decision unless spec explicitly allows auto-continue
-> expose result through sp_status/controller_feedback
```

fallback summary 是部分证据，不是成功报告。controller 应根据风险选择 retry、inspect、accept partial、revise workflow 或 cancel。

### 5.6 Progress 与模型上下文边界

progress 的目标是给用户看见运行状态，不是驱动大模型推理。

- 详细执行过程使用 OpenCode 原生 child session timeline。插件创建 node session 时必须使用 `session.create(parentID)`，让 OpenCode 保留 parent-child session 关系。
- 主会话区域只展示确认、摘要、入口、attention 和按需 progress digest，不把 child session 的每个 message part 复制成 parent timeline 内容。
- `app_bottom` 显示当前 workflow 和 running node 的简短状态。
- `sidebar_content` 显示 prepared execution task、workflow-spec、node graph、reports、fallback 和 attention。
- `prompt_progress` 显示当前上下文一行状态。
- 主会话灰色 tool result 可展示 `sp_status(include_progress=true)` 的按需 progress digest。

progress 不应长期注入 node prompt，也不能替代 `sp_report` 的结构化结果。OpenCode 原生 child session timeline 是详细过程的展示面，TUI/progress digest 是摘要面。

### 5.7 异常场景下的主控反应

controller 面对异常时先对齐事实，再选择工具动作：

| 异常 | plugin 反馈 | controller 动作 |
|---|---|---|
| 系统重启后发现 running node | `recovered_unknown`、interrupted node 或 startup recovery note | 调 `sp_status`，选择 inspect、retry、cancel 或重新 prepare/start。 |
| prepare-phase designer 中断 | prepare state 保留 pending designer 和 candidate artifact | 继续 prepare、恢复 designer、重新 prepare 或跳过 designer。 |
| planner 中断或失败 | `plan.md` / `task_graph.json` 不 promotion，不自动扩展 | retry planner、修正需求、切到 `plan-only` 收束或取消。 |
| implementation / review / verify failed | terminal failed report，除非 workflow 有 failure edge，否则等待 controller | retry、复用 implementer、派发调查/修复节点、修改 workflow 或 cancel。 |
| child session stalled | progress 标记 stalled，但不自动失败 | 查看原生 child session timeline，或 `sp_status(include_progress=true)` 后决定 wait/inspect/retry/cancel。 |
| child session 无 `sp_report` | fallback summary，进入 controller decision | 把 fallback 当部分证据，按风险 retry、accept partial、revise workflow 或 cancel。 |
| node needs_user | pending question 写入 state，并通知 parent | 主会话问用户，得到答案后恢复原 child session。 |
| expansion 校验失败 | 保存 report，拒绝追加 invalid nodes | 要求 planner 修正、手工 orchestration、关闭 auto expansion 或 cancel。 |
| required artifact 缺失 | blocked / controller decision | 恢复 producer、批准 candidate、重新生成 artifact 或裁剪 workflow。 |
| late report | 只作为审计，不覆盖 newer/canceled state | 查看证据但继续以最新 attempt 为准。 |

这些分支的共同目标是把状态闭合到明确 decision point。plugin 不做语义猜测，controller 也不靠记忆继续；二者通过 `sp_status`、`controller_feedback`、`sp_start`、`sp_cancel` 和 `sp_report` 协作恢复。

## 6. Workflow 文档生命周期

v5 需要把插件可控的 workflow artifacts 作为 prepare/start 的显式 contract，而不是让节点随手查找文件。

- runtime control documents: 插件生成，用于调度、恢复和审计，例如 `state.json`、`events.jsonl`、`workflow-spec.json`、`documents.json`、`nodes/<node-id>/task.md`、`nodes/<node-id>/record.json`、`nodes/<node-id>/fallback-summary.json`。
- workflow artifact documents: 放在 `.opencode/superpowers/runs/<run-id>/` 下，由插件读取并传给 node agent 的上下文，例如 `request.md`、`spec.md`、`plan.md`、`task_graph.json`、`tasks.json`、`reports/<task-id>/task.md`、`reports/<task-id>/report.md`、`reports/<task-id>/verification.md`。节点消费的 `spec.md` 和 `plan.md` 指的是这一层。

### 6.1 启动配置中的文档协议

controller 提交启动配置时，应声明文档 contract：

```ts
type WorkflowDocumentSpec = {
  id: string
  title: string
  kind: "workflow_artifact"
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
```

node 通过 `consumes` 和 `produces` 引用 document id。`kind="workflow_artifact"` 的 `path` 相对 run 目录。插件校验这些引用，但不替 controller 决定哪些 workflow artifacts 应该存在。

### 6.2 生成时机

- controller intake: 只在主会话中问清需求和展示草案。用户未批准前，不需要 materialize run-local workflow artifacts。
- `sp_prepare`: 插件写入或更新 `request.md`、`documents.json`、`state.json` 和 `events.jsonl`；需要 designer 参与时，designer 输出进入 `spec.md` candidate 或 node record。
- `sp_start(start_prepared_task)`: 插件把内置 workflow 或自定义 orchestration 规范化为 `workflow-spec.json`，并在 `state.json` 中记录启动配置和 auto expansion policy。
- `sp_start` 派发 node 前生成 `nodes/<node-id>/task.md`；如果有 `task_id`，同时生成 `reports/<task-id>/task.md`。
- prepare-phase designer 或 start 后 planner node: 通过 `sp_report.artifacts` 产出 `spec`、`plan`、`task_graph` 等 candidate；插件把它们保存在 run 目录下。
- promotion 条件满足：插件把 candidate materialize 成 canonical workflow artifact，例如 `spec.md`、`plan.md`、`task_graph.json`、`tasks.json`。常见条件是 `on_node_passed`；需要人工确认的设计可使用 `on_controller_approval`。
- report-driven expansion：如果 `sp_report` 同时包含 task graph 或 workflow expansion，插件在 canonical artifact 生成后按 workflow auto expansion policy 校验和追加节点。
- implementer/reviewer/verifier node: 插件读取 canonical workflow artifacts 并内联到 node prompt；这些 node 不应自行搜索 run 目录之外的 `spec.md` 或 `plan.md`。

### 6.3 candidate 与 canonical

- `progress` report 产生的 workflow artifact 只能是 candidate/progress，不能解锁下游。
- `passed` report 可以让 `promotion="on_node_passed"` 的 workflow artifact 成为 canonical。
- `promotion="on_controller_approval"` 的 workflow artifact 必须等待 controller 明确批准后才能成为 canonical；默认 plan 后执行路径应使用 `on_node_passed`，避免回到 controller 才能继续。
- 下游 node 只能消费已经 canonical、且在 `consumer_node_ids` 中允许它消费的 workflow artifact。
- 如果 required workflow artifact 缺失、stale 或没有 canonical，transition 应返回 controller decision 或 blocked，不能让 node 自行搜索替代材料。

常见例子：

- `sp-designer` 在 prepare 阶段产出的 spec 通常先作为 `spec.md` candidate，用户确认后可成为 canonical `spec.md`，由插件传给 planner；如果 workflow 明确要求人工确认，可设为 `on_controller_approval`。
- `sp-planner` 产出的 plan/task graph 通常在 `passed` 后成为 canonical `plan.md`、`task_graph.json` 和 `tasks.json`；当 auto expansion policy 允许时，插件据此追加 implementer、reviewer、verifier 等后续节点。
- 每个 child node 的 `nodes/<node-id>/task.md` 总是由插件生成，用于证明该 node 收到的任务范围。

## 7. Controller 决策表

| 场景 | controller 应做什么 | 推荐工具 |
|---|---|---|
| 用户提出新需求，但目标/范围/验收不清 | 主会话澄清，先不 prepare | 无或 `sp_status` |
| 用户需求清楚，准备交给插件执行 | 生成 task brief，并准备用户确认内容 | `sp_prepare` |
| 用户要求修改 prepared execution task | 修改 task brief 后重新 prepare | `sp_prepare` |
| 用户确认 prepared execution task | 选择内置 workflow 代号或自定义编排并启动 | `sp_start(action="start_prepared_task")` |
| 需要 designer 参与 | 在 prepare 阶段请求 designer brainstorming/design | `sp_prepare` |
| 不需要 designer 参与 | prepare 时 `design_participation.mode="none"`；start 只包含后续执行节点，可只有一个 node | `sp_prepare` -> `sp_start` |
| 只做 design/plan/review | 选择 `design-only`、`plan-only`、`review-only` 等 `*-only` workflow，或显式关闭 auto expansion | `sp_start` |
| 用户问当前进度 | 读取事实和 progress digest | `sp_status(include_progress=true)` |
| node report passed 且 edge 明确 | 插件可自动派发；controller 等状态反馈 | `sp_status` 按需 |
| node report passed 且产生合法 expansion | 插件按 policy 自动追加并派发；controller 不重新规划 | `sp_status` 按需 |
| node report passed 且只有 task_graph | 插件按 deterministic defaults 转成 nodes；缺默认 agent 或校验失败则反馈 controller | `sp_status` 按需 |
| node report 产生 expansion 但 auto expansion policy 禁止 | 插件保存 artifact，不追加节点；按 workflow completion policy 结束或继续 | `sp_status` 按需 |
| node report 产生 expansion 但校验失败 | controller 查看错误后 revise workflow、retry 或 cancel | `sp_status` -> `sp_prepare` / `sp_start` / `sp_cancel` |
| node report failed/blocked 且 workflow 无明确 edge | controller 选择 retry/revise/cancel | `sp_status` -> `sp_start` 或 `sp_cancel` |
| node needs_user | 向用户提问，拿到答案后恢复原 node | `sp_start(resume_input)` |
| child 无 report，只有 fallback summary | 视为部分证据，决策 retry/inspect/accept partial/cancel | `sp_status` -> `sp_start` 或 `sp_cancel` |
| 状态混乱或重启恢复后不确定 | 以 durable state 为准重新对齐 | `sp_status` |
| 用户要求停止 | 明确 scope 后取消 | `sp_cancel` |

## 8. 当前实现差距

从现有代码看，后续实现至少需要补齐这些点：

- `src/agents/index.ts` 的 `super-agent` prompt 仍强调 v4 planning-driven 固定顺序，需要替换成动态 workflow principles。
- `super-agent` prompt 需要加入 prepare-first 工具协议、prepare 阶段 designer 参与判断、built-in workflow templates 和常用 workflow 示例，但明确 templates/examples 不是插件智能建议。
- `sp_prepare` 当前仍围绕固定 kind / prepare mode，需要改为 task preparation、既有 artifact persistence、confirmation summary，并支持 prepare-phase designer participation。
- `sp_start` 需要支持 `built_in_workflow` 和 `orchestration` 两类启动配置，并允许 orchestration 只有一个 node。
- transition 仍主要由固定 router/workflow 规则驱动，需要改为读取 `state.json`、`workflow-spec.json` 和 node result。
- 需要实现基于 `*-only` 默认值和显式 override 的 auto expansion policy，以及 `sp_report.task_graph` / `sp_report.workflow_expansion` 到 workflow graph 的自动追加。
- 需要给自动扩展增加最大节点数、允许来源 node、允许目标 agent、默认 task agent、递归深度和默认 check chain 等 guard。
- 需要在 `state.json` / `events.jsonl` 中持久化 prepare/start 状态，在 `workflow-spec.json` 和 `documents.json` 中持久化规范化 workflow 与文档 contract，并把静态能力目录、built-in templates、常用示例和 run state 分开。
- 需要实现 document contract 校验、candidate/canonical promotion 和 node-document 关联。
- 需要实现 no-report fallback summary 的检测、摘要、落盘和 controller feedback。
- TUI progress 需要按动态 node graph 展示，不再假设固定 phase。
- 测试需要覆盖 tool 调用边界、fallback、late report、waiting_user resume、dynamic edge dispatch 和 recovery。

## 9. 设计自检

- 不把 Superpowers 理念固化为固定 workflow；controller 根据任务性质决定 prepare 行为和启动配置。
- 内置 workflow templates 和常用 workflow examples 只作为 prompt/capability 参考，不能变成插件智能规划或固定流程。
- 每个执行任务都经过 `sp_prepare`，用户确认后才 `sp_start`。
- `sp-designer` 的头脑风暴/设计参与发生在 prepare 阶段，不作为 start 后才开始的默认执行节点。
- `sp_start` 可使用内置 workflow id 或自定义 orchestration；orchestration 可以只有一个 node。
- 五个 public tools 保持不变，符合 v5 PRD 的 public surface。
- controller、plugin、node agent 三者职责分开：controller 决策，plugin 执行和持久化，node agent 汇报。
- workflow artifacts 通过 `documents` contract 关联 node，生成时机、run-local path、plugin inline 传递和 promotion 规则明确。
- `sp_report` 和 fallback summary 进入同一 transition 入口，但 fallback 不默认成功。
- 用户输入、取消、恢复、late report、progress 都有明确 runtime 入口。
- progress 只做可见性，不驱动状态机。

## 10. 后续实现建议

实现可以分三步：

1. 先改 `super-agent` prompt 和 agent catalog 文档，让 controller 规划理念先对齐 v5。
2. 扩展 `sp_prepare` / state schema，支持 task preparation、既有 artifact persistence、confirmation summary、prepare-phase designer participation 和 `documents` 注册。
3. 扩展 `sp_start` / transition，支持 built-in workflow id、自定义 orchestration、单节点 orchestration，以及基于 `*-only` 默认值的 auto expansion policy。
4. 改 document promotion 与 fallback runtime，使 workflow-spec、文档 contract、`sp_report` 和 fallback summary 进入统一调度入口。
