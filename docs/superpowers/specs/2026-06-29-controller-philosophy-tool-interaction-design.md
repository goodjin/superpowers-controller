# Superpowers Controller V5 Architecture And Tool Interaction Design

## 1. Purpose

本文档补充 `2026-06-28-controller-prd-v5.md`，目标是把 Superpowers 官方技能体现出的工作理念整理成总控 agent prompt 的一部分，并明确 `sp_status`、`sp_prepare`、`sp_start`、`sp_report`、`sp_cancel` 在 v5 prepare/start 工具协议下的调用场景、行为、workflow-spec 调度边界、TUI 交互方式和插件-大模型交互方式。

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

`superpowers-agent` 是总控，不是实现者。它应该理解需求、规划 workflow、解释状态、向用户确认关键点，并通过 public tools 推进运行时。

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

应在 `superpowers-agent` prompt 中加入一个独立的 Superpowers Operating Principles 区块。该区块要指导 controller 先 prepare，再 start，而不是重复固定 v4 流程。

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

Use OpenCode native child sessions for detailed node execution visibility. Do not mirror every child message part into the parent conversation. The parent session remains the durable control surface, but the TUI main content area should automatically focus the currently running child session when workflow execution is active. Users can interact with the focused child session directly. If multiple child sessions are running in parallel, expose keyboard shortcuts to switch between them and show those shortcuts in the UI. The right sidebar should show live workflow state, total session count, running session count, and a TodoWrite-style session list with active sessions first. Detailed tool calls, patches, reasoning, and text remain in the focused child session timeline.

When runtime state is confusing, call sp_status and follow controller_feedback. If a node reports needs_user, collect the user's answer from the parent conversation or the currently focused child session, then resume the original node with sp_start(resume_input). If a node has no sp_report and the plugin returns fallback summary, treat it as partial evidence and choose retry, inspect, accept partial, revise workflow, or cancel according to risk.
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
- 当 plugin 不能安全自动继续时，返回 `allowed_controller_decisions`，包含每个决策的 reason、risk、最小 payload 和推荐工具调用。
- v5 中还可以返回 agent catalog、workflow schema、built-in workflow templates 和常用 workflow 示例。它们是确定性能力说明，不是插件智能规划结果。

插件与大模型交互：

- controller 调用工具后，插件同步返回结构化 JSON。
- 大模型只根据返回值解释状态和选择下一步工具，不应靠自己记忆覆盖 `sp_status`。
- 大模型提交裁决前，应只选择 `sp_status.allowed_controller_decisions` 中允许的动作；如果用户目标需要的动作不在列表里，先重新 `sp_prepare` 或向用户说明阻塞。
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
- 如果 `design_participation.mode` 不是 `none`，先生成或更新 prepare-stage `workflow-spec.json`，其中必须显式包含 designer node、确认 gate、artifact contract 和恢复策略。
- prepare-stage `workflow-spec.json` 落盘后，才能调度 `sp-designer` 做 prepare-phase brainstorming/design，并把输出保存为 `spec.md` candidate 或 node record。
- 返回 `prepared_task_id`、`confirmation_summary`、`required_user_confirmations`、warnings 和 recommended_next。
- 除 prepare-phase designer 外，不创建执行 child session。
- 不替 controller 选择 designer 是否参与。
- 不选择内置 workflow。
- 不校验最终 workflow 编排。
- 不在没有 workflow-spec node 记录的情况下直接派发 designer。

插件与大模型交互：

- 插件把 prepare state、artifact 路径和确认摘要返回给 controller。
- controller 在主会话把 `confirmation_summary` 展示给用户。
- 用户要求修改时，controller 重新澄清后再次调用 `sp_prepare`。
- 用户确认后，controller 调用 `sp_start` 并提交启动配置。

### 4.3 `sp_start`

定位：基于 prepared task、用户确认依据和启动配置激活、恢复、重试、继续执行。

调用场景：

- 用户确认 prepared execution task 后启动。
- controller 已决定使用内置 workflow 代号或自定义 workflow orchestration。
- workflow 等待用户输入，controller 已收集答案，需要恢复原 child session。
- workflow 处于 recovered/blocked/waiting_controller_decision，controller 选择 retry、inspect、accept partial、continue 或 cancel 之外的继续动作。
- 某个 node 已 report，插件反馈需要 controller 明确选择下一步。

行为：

- `start_prepared_task` 必须携带 `prepared_task_id`、`confirmation` 和 `start_config`。
- `confirmation` 必须包含 `user_confirmed: true`，并记录 `user_message` 或 `confirmed_by_session_id` 等审计依据。
- direct start payload 无效；缺少 `prepared_task_id`、`confirmation` 或 `start_config` 时，插件必须拒绝并返回可修正的 controller feedback。
- 校验 prepare state 是否存在、是否仍可启动，以及 confirmation 是否匹配当前 prepared task。
- 校验启动配置；校验通过后，把 `PrepareState.status` 记录为 `confirmed`。
- `built_in_workflow`: 根据 workflow id 实例化内置 template，并应用 overrides。
- `orchestration`: 使用 controller 传入的 nodes、edges、documents、completion policy 和 fallback policy；nodes 允许只有一个。
- 根据 workflow id 默认值和可选 `auto_expansion` override 生成 auto expansion policy；`*-only` 默认禁止自动扩展。
- 将 built-in template 或 custom orchestration 规范化为当前 stage 的 `workflow-spec.json` 并落盘；runtime 后续调度只能读取该 spec。
- 激活 workflow 时，计算 initial runnable nodes 并通过 orchestrator 创建或复用 child session。
- resume_input 时消费 pending question，并把回答发回原 node session，不创建新 node。
- retry 时创建新 attempt 或复用允许复用的 session，不能覆盖旧 attempt 的 record。
- 如果已有 running node，不重复派发，返回 wait 和当前状态。
- 如果存在已校验的 report-driven expansion，且 auto expansion policy 允许，插件先把 expansion patch 写入 `workflow-spec.json`，再重新计算并派发新的 runnable node，不要求 controller 重新规划。
- 如果 auto expansion policy 禁止，插件不应用 report 中的新任务，只保存 artifact，并按 `workflow-spec.json` 的 completion policy 结束或继续已有节点。
- `resolve_controller_decision` 时，插件只接受 `sp_status.allowed_controller_decisions` 中列出的 decision kind，例如 continue、retry node、apply workflow patch、replace orchestration、accept partial、mark blocked 或 request reprepare。
- accept partial 必须记录 evidence refs 和 caveat，不能伪装成完整成功。
- 返回 fresh state，而不是 dispatch 前的旧快照。

插件与大模型交互：

- controller 只调用 `sp_start` 表达用户确认后的启动、恢复、重试或控制决策。
- controller 使用 `sp_start(resolve_controller_decision)` 提交异常路径裁决。该工具承担 `sp_decide` 的角色，因此不新增 public tool。
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
- `passed` report 中的 `task_graph` 或 `workflow_expansion` 会进入 expansion 校验；policy 允许且校验通过时，插件先 patch `workflow-spec.json`，再重新计算 runnable nodes 并继续派发。
- policy 禁止扩展时，`task_graph` 或 `workflow_expansion` 只作为 artifact 或 report evidence 保存，不进入可执行 graph。
- terminal report 进入统一 transition，插件根据 `state.json`、`workflow-spec.json` edge、completion_policy 和 fallback_policy 计算下一步。
- report 不能包含 `next_action`、`next_suggestion`、`child_session_id`、`reuse_session_id` 或其它 control-plane 字段。node agent 的观察只能放进 `summary` 或 `findings`，由 controller 或 workflow policy 决定是否采用。

插件与大模型交互：

- node agent 调用工具后，插件在该 child session 返回 tool result，说明记录和后续调度状态。
- 如果 transition 可以自动推进，插件在后台派发下一个 node。
- 如果 report 产生了合法 expansion，插件先写入新的 `workflow-spec.json` 版本，再重新计算 runnable nodes；planner 完成后不默认回 controller。
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

- `superpowers-agent` 总控 agent。
- `sp-*` node agents。
- public tools: `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- agent permissions: controller 禁止 native task 和业务 skill；node 禁止 native task/question，只允许指定 primary skill。

这一步决定了大模型能看到哪些 agent、工具和权限边界。

### 5.2 主会话控制循环

主会话里的 `superpowers-agent` 只做控制循环：

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
-> optional expansion validation and workflow-spec patch
-> transition or controller feedback
```

node prompt 应包含 scoped task、required context、source artifacts、expected output 和 report_contract。node agent 不应自行搜索 workflow artifact，也不应把 prompt 外的猜测当成状态来源。

当 planner 或其它 node 在 `sp_report` 中返回 `task_graph` 或 `workflow_expansion`：

- `workflow_expansion`：插件校验新增 node、edge、document、agent、artifact 引用、最大节点数和递归深度；通过后先作为 patch 写入当前 `workflow-spec.json`，再派发新的 runnable node。
- `task_graph`：插件只做确定性转换。每个 task 变成一个 node，agent 来自 task.agent 或 workflow auto expansion policy 的 `default_task_agent`，depends_on 变成 edges，`default_check_chain` 变成附加检查节点。缺少 agent、超出 allowed_target_agents、超出数量或深度限制时，不猜测补齐。
- auto expansion policy 禁止：插件保存 report 和 artifact，但不把新增任务加入 workflow。该模式用于 `design-only`、`plan-only`、`review-only` 或只跑指定节点等场景。
- expansion 校验失败：插件把失败原因写入 controller_feedback，workflow 进入需要 controller 决策或 blocked 状态。

### 5.4 等待用户输入

当 node agent 需要用户输入：

```text
node agent -> sp_report(status="needs_user", question=...)
plugin writes pending_question
plugin notifies parent controller session and updates TUI focus/attention
superpowers-agent asks user in main conversation, or TUI keeps the focused child session available for direct user reply
user answers
superpowers-agent -> sp_start(resume_input)
plugin resumes original child session
```

这个机制保证用户问题有 durable control-plane 记录，且原 child session 可以恢复上下文，不需要创建一个脱离 state 的新 session。TUI 可以让用户在当前 focused child session 中交互，但结构化恢复仍必须通过 `pending_question` 和 `sp_start(resume_input)` 完成。

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

### 5.6 TUI 交互模型和模型上下文边界

TUI 的目标是让用户始终看到当前 workflow 正在发生什么，并能进入正在运行的子会话交互；它不是 workflow transition 的输入，也不能替代 `sp_report`。

#### 5.6.1 主视图自动聚焦策略

- 父会话仍是 durable control surface：prepared task confirmation、controller decision、恢复、取消和最终交付都归属父会话。
- TUI 的主内容区域是 visual focus surface。workflow 有 running child session 时，主内容区域应自动切换到当前 active child session 的原生会话界面。
- 当前只有一个 running child session 时，自动聚焦该 child session。
- 当前有多个 running child sessions 时，默认聚焦最新进入 running 的 session；用户可以通过快捷键切换到其它 running session。
- 当前没有 running child session，但存在 `waiting_user`、`waiting_controller_decision`、`blocked`、`failed` 或 `finished` 状态时，主内容区域回到父会话或当前需要用户决策的 session。
- 自动聚焦只改变 TUI 视图和输入目标，不改变 `parent_session_id`、workflow owner、node ownership 或 runtime state。

#### 5.6.2 子会话交互策略

- 聚焦到 child session 后，用户可以直接在该 child session 的输入区域与对应 node agent 交互。
- node agent 仍必须通过 `sp_report` 提交结构化结果、失败、阻塞或 `needs_user`。用户在 child session 的自然语言补充只能作为该 node 的上下文，不能直接改变 workflow state。
- node 如果需要可恢复的用户输入，应调用 `sp_report(status="needs_user")` 写入 `pending_question`；TUI 可以继续停留在该 child session 或根据状态切回父会话，但恢复仍通过 `sp_start(resume_input)` 进入原 child session。
- 用户在 child session 里触发取消、重试、接受部分结果等控制面动作时，controller 仍应通过父会话和 public tools 落盘；child session 不直接执行 control-plane decision。

#### 5.6.3 并行子会话快捷键

并行 running sessions 必须有可见、稳定的切换方式：

- TUI 为当前 workflow 的 visible session list 分配快捷键，推荐 `⌘1` 到 `⌘9` 对应列表前 9 个 session，`⌘[` / `⌘]` 在列表中向前/向后切换。
- 快捷键绑定必须显示在 UI 中，至少显示在右侧 session list 的每一行；例如 `⌘1 sp-implementer T1 running`。
- 快捷键顺序跟右侧列表顺序一致。活跃 session 排在前面，因此 active running sessions 优先拿到低编号快捷键。
- session 状态变化导致列表重排时，TUI 必须同步刷新快捷键展示，避免用户看到的快捷键和实际目标不一致。
- 超过 9 个 session 时，`⌘1` 到 `⌘9` 只绑定前 9 个可见 session；其余 session 仍通过上下移动、搜索或列表选择进入。
- 如果当前 OpenCode TUI adapter 暂不支持直接注册全局快捷键，第一版可以降级为 sidebar 显示快捷键提示和 session list 选择事件；快捷键是交互目标，不是 runtime correctness 前提。

#### 5.6.4 右侧 `sidebar_content`

右侧 sidebar 是 workflow 的实时状态面板，应由 runtime state、node runs 和 progress digest 驱动，不从模型自然语言推断。

顶部摘要必须包含：

- workflow title / status / current stage。
- current focused session。
- total sessions。
- running sessions。
- waiting / blocked / failed / fallback attention。
- last updated time 或 state version。

摘要下面展示当前 workflow 的所有 session 列表：

- 列表按状态排序：running / needs_user / waiting_controller_decision / blocked / failed / interrupted / queued / passed / canceled / superseded。
- 同状态内按最新 activity 时间倒序。
- 活跃 session 必须排在前面。
- 列表样式与 TodoWrite 展示一致：每行一个 item，左侧状态符号或状态色块，中间是 agent、node title、task id 或 session id，右侧显示快捷键、耗时或最近 activity。
- 每行应能表达最小状态：`shortcut`、`agent`、`node_id`、`task_id?`、`session_id`、`status`、`phase/stage`、`last_activity`、`attention?`。
- running 行应突出显示；当前 focused session 需要有额外标记。
- needs_user、blocked、failed、fallback 行应显示简短 attention 文案，方便用户知道为什么需要切换或决策。

示例布局：

```text
Workflow: Feature implementation   Status: running   Stage: execution
Sessions: 7 total / 2 running       Focus: ⌘1 sp-implementer T3
Attention: 1 needs_user, 0 blocked, 0 fallback

[running]  ⌘1  sp-implementer  T3  edit workflow-spec parser     02:14
[running]  ⌘2  sp-verifier     T2  run regression checks          00:48
[needs]    ⌘3  sp-designer     D1  asks for API boundary          waiting user
[passed]   ⌘4  sp-planner      P1  produced task graph            12:03
[passed]   ⌘5  sp-acceptance   T1  accepted implementation        08:31
```

#### 5.6.5 Progress 边界

- `app_bottom` 显示 workflow title/status、focused session、running count 和当前 attention。
- `sidebar_content` 显示实时 workflow summary 和 TodoWrite-style session list。
- `prompt_progress` 显示当前上下文一行状态。
- 主会话灰色 tool result 可展示 `sp_status(include_progress=true)` 的按需 progress digest。
- progress 不应长期注入 node prompt，也不能替代 `sp_report` 的结构化结果。
- OpenCode 原生 child session timeline 是详细过程的展示面；sidebar/progress digest 是摘要面；runtime state 和 `workflow-spec.json` 才是调度事实源。

#### 5.6.6 PRD 同步项

当前 PRD v5 的 TUI 验收仍偏向“主会话只显示摘要”。本架构文档新增了主内容区域自动聚焦 running child session、并行子会话快捷键和 TodoWrite-style sidebar session list。后续应同步 PRD 的 TUI 验收标准，避免 PRD 与架构文档在交互契约上出现冲突。

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
| node needs_user | pending question 写入 state，通知 parent，并在 TUI sidebar 标记 attention | 主会话或当前 focused child session 收集用户回答，得到答案后通过 `sp_start(resume_input)` 恢复原 child session。 |
| expansion 校验失败 | 保存 report，拒绝追加 invalid nodes | 要求 planner 修正、手工 orchestration、关闭 auto expansion 或 cancel。 |
| required artifact 缺失 | blocked / controller decision | 恢复 producer、批准 candidate、重新生成 artifact 或裁剪 workflow。 |
| late report | 只作为审计，不覆盖 newer/canceled state | 查看证据但继续以最新 attempt 为准。 |

这些分支的共同目标是把状态闭合到明确 decision point。plugin 不做语义猜测，controller 也不靠记忆继续；二者通过 `sp_status`、`controller_feedback`、`sp_start`、`sp_cancel` 和 `sp_report` 协作恢复。

### 5.8 工具充分性结论

现有五个 public tools 够用，但 `sp_status` 和 `sp_start` 必须承担更明确的裁决协议：

```text
expected path:
  node report/fallback + workflow-spec -> exactly one safe next step -> plugin auto-advances

exception path:
  no safe single next step -> plugin writes waiting_controller_decision
  controller calls sp_status
  sp_status returns allowed_controller_decisions
  controller chooses one decision
  controller calls sp_start(resolve_controller_decision)
```

不需要新增 `sp_decide`：

- `sp_status` 已经是只读事实源和 feedback 入口。
- `sp_start` 已经是 controller 确认后推进 runtime 的写入口。
- 把裁决放进 `sp_start(resolve_controller_decision)`，可以继续使用 `expected_state_version` 防 stale decision。
- 保持五个 public tools 可以减少 controller 在异常场景下的工具选择歧义。

如果后续实现发现 `sp_start` 无法表达某个裁决，优先扩展 `ControllerDecision` union，而不是新增工具。

## 6. 数据结构与所有权规约

本节定义 v5 runtime 必须共享的核心数据结构。类型形状可以在实现中细化，但所有权、写入时机和恢复语义必须保持一致。

### 6.1 核心类型

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
    status: "not_requested" | "running" | "completed" | "blocked"
    node_id?: string
    artifact_id?: "spec"
  }
  documents?: WorkflowDocumentSpec[]
}

type StartConfirmation = {
  user_confirmed: true
  user_message?: string
  confirmed_by_session_id?: string
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

type WorkflowSpec = {
  version: "v5"
  spec_version: number
  stage: WorkflowStage
  source:
    | { kind: "prepare"; prepared_task_id: string }
    | { kind: "built_in_template"; workflow_id: BuiltInWorkflowId }
    | { kind: "controller_orchestration" }
    | { kind: "report_expansion"; source_node_id: string }
    | { kind: "controller_decision"; decision_id: string }
  orchestration: WorkflowOrchestration
  auto_expansion_policy: AutoExpansionPolicy
}

type WorkflowStage =
  | "prepare"
  | "planning"
  | "execution"
  | "review"
  | "finish"
  | "recovery"

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

type ControllerDecision =
  | { kind: "continue_existing_graph"; reason: string }
  | { kind: "retry_node"; node_id: string; reason: string; reuse_session?: boolean }
  | { kind: "apply_workflow_patch"; patch: WorkflowExpansionPatch; reason: string }
  | { kind: "replace_orchestration"; orchestration: WorkflowOrchestration; reason: string }
  | { kind: "accept_partial_result"; node_id?: string; reason: string; evidence_refs: string[] }
  | { kind: "mark_blocked"; reason: string; required_user_action?: string }
  | { kind: "request_reprepare"; reason: string }
```

### 6.2 所有权和写入时机

| 数据 | 创建者 | 更新者 | 持久化位置 | 恢复语义 |
|---|---|---|---|---|
| `PrepareState` | `sp_prepare` | `sp_prepare`、`sp_start(start_prepared_task)`、`sp_cancel` | `state.json` / `events.jsonl` | 任务准备事实。`prepared` 不能直接执行；只有带有效 `StartConfirmation` 的 `sp_start` 才能变成 `confirmed`。 |
| `StartConfirmation` | controller 通过 `sp_start` 提交 | 不更新，只审计 | `state.json` / `events.jsonl` | 证明用户已确认 prepared task。缺失时拒绝启动。 |
| `StartConfig` | controller 通过 `sp_start` 提交 | `replace_orchestration` 或 reprepare 后替换 | `state.json` | 启动意图。不能直接驱动 dispatch，必须先规范化成 `WorkflowSpec`。 |
| `WorkflowSpec` | `sp_prepare`、`sp_start`、合法 expansion 或 controller decision | transition engine / state store | `workflow-spec.json` / `events.jsonl` | dispatch 的 graph 事实源。恢复时不得用 workflow id 或 event kind 补派 spec 外节点。 |
| `WorkflowDocumentSpec` | controller orchestration、built-in template 或 expansion | document promotion / workflow patch | `documents.json` / `workflow-spec.json` | artifact contract。缺 required canonical artifact 时 transition 返回 blocked 或 controller decision。 |
| `AutoExpansionPolicy` | built-in default + start override | workflow patch / replace orchestration | `state.json` / `workflow-spec.json` | 判断 report expansion 是否可自动应用的 guard。 |
| `ControllerDecision` | controller 读取 `sp_status.allowed_controller_decisions` 后提交 | 不更新，只审计 | `events.jsonl` / `state.json` | 异常路径唯一裁决输入。插件必须校验 state version、node、artifact 和 policy。 |

### 6.3 Dispatch 不变量

- `StartConfig` 和 built-in workflow id 只能生成 `WorkflowSpec`，不能直接决定下一个 agent。
- transition engine 只读取 `WorkflowState`、当前 `workflow-spec.json`、latest report/fallback、artifact canonical 状态和 auto expansion policy。
- 每个要派发的 node 必须存在于当前 `workflow-spec.json`；不存在时只能进入 `waiting_controller_decision` 或 `blocked`。
- 每次 workflow expansion、workflow patch 或 orchestration replacement 必须先写入新的 `workflow-spec.json` 版本，再计算 runnable nodes。
- session orchestrator 只接收 transition 已经产出的 dispatch decision；它不读取 workflow id、event kind 或模型自然语言来决定下一步。

## 7. Workflow 文档生命周期

v5 需要把插件可控的 workflow artifacts 作为 prepare/start 的显式 contract，而不是让节点随手查找文件。

- runtime control documents: 插件生成，用于调度、恢复和审计，例如 `state.json`、`events.jsonl`、`workflow-spec.json`、`documents.json`、`nodes/<node-id>/task.md`、`nodes/<node-id>/record.json`、`nodes/<node-id>/fallback-summary.json`。
- workflow artifact documents: 放在 `.opencode/superpowers/runs/<run-id>/` 下，由插件读取并传给 node agent 的上下文，例如 `request.md`、`spec.md`、`plan.md`、`task_graph.json`、`tasks.json`、`reports/<task-id>/task.md`、`reports/<task-id>/report.md`、`reports/<task-id>/verification.md`。节点消费的 `spec.md` 和 `plan.md` 指的是这一层。

### 7.1 启动配置中的文档协议

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

### 7.2 生成时机

- controller intake: 只在主会话中问清需求和展示草案。用户未批准前，不需要 materialize run-local workflow artifacts。
- `sp_prepare`: 插件写入或更新 `request.md`、`documents.json`、`state.json` 和 `events.jsonl`；需要 designer 参与时，designer 输出进入 `spec.md` candidate 或 node record。
- `sp_start(start_prepared_task)`: 插件把内置 workflow 或自定义 orchestration 规范化为 `workflow-spec.json`，并在 `state.json` 中记录启动配置和 auto expansion policy。
- `sp_start` 派发 node 前生成 `nodes/<node-id>/task.md`；如果有 `task_id`，同时生成 `reports/<task-id>/task.md`。
- prepare-phase designer 或 start 后 planner node: 通过 `sp_report.artifacts` 产出 `spec`、`plan`、`task_graph` 等 candidate；插件把它们保存在 run 目录下。
- promotion 条件满足：插件把 candidate materialize 成 canonical workflow artifact，例如 `spec.md`、`plan.md`、`task_graph.json`、`tasks.json`。常见条件是 `on_node_passed`；需要人工确认的设计可使用 `on_controller_approval`。
- report-driven expansion：如果 `sp_report` 同时包含 task graph 或 workflow expansion，插件在 canonical artifact 生成后按 workflow auto expansion policy 校验；通过后先更新 `workflow-spec.json`，再派发新增 runnable nodes。
- implementer/reviewer/verifier node: 插件读取 canonical workflow artifacts 并内联到 node prompt；这些 node 不应自行搜索 run 目录之外的 `spec.md` 或 `plan.md`。

### 7.3 candidate 与 canonical

- `progress` report 产生的 workflow artifact 只能是 candidate/progress，不能解锁下游。
- `passed` report 可以让 `promotion="on_node_passed"` 的 workflow artifact 成为 canonical。
- `promotion="on_controller_approval"` 的 workflow artifact 必须等待 controller 明确批准后才能成为 canonical；默认 plan 后执行路径应使用 `on_node_passed`，避免回到 controller 才能继续。
- 下游 node 只能消费已经 canonical、且在 `consumer_node_ids` 中允许它消费的 workflow artifact。
- 如果 required workflow artifact 缺失、stale 或没有 canonical，transition 应返回 controller decision 或 blocked，不能让 node 自行搜索替代材料。

常见例子：

- `sp-designer` 在 prepare 阶段产出的 spec 通常先作为 `spec.md` candidate，用户确认后可成为 canonical `spec.md`，由插件传给 planner；如果 workflow 明确要求人工确认，可设为 `on_controller_approval`。
- `sp-planner` 产出的 plan/task graph 通常在 `passed` 后成为 canonical `plan.md`、`task_graph.json` 和 `tasks.json`；当 auto expansion policy 允许时，插件据此生成 workflow-spec patch，再追加 implementer、reviewer、verifier 等后续节点。
- 每个 child node 的 `nodes/<node-id>/task.md` 总是由插件生成，用于证明该 node 收到的任务范围。

## 8. Controller 决策表

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
| node report passed 且产生合法 expansion | 插件按 policy 先更新 `workflow-spec.json`，再自动追加并派发；controller 不重新规划 | `sp_status` 按需 |
| node report passed 且只有 task_graph | 插件按 deterministic defaults 转成 nodes；缺默认 agent 或校验失败则反馈 controller | `sp_status` 按需 |
| node report 产生 expansion 但 auto expansion policy 禁止 | 插件保存 artifact，不追加节点；按 workflow completion policy 结束或继续 | `sp_status` 按需 |
| node report 产生 expansion 但校验失败 | controller 查看错误后 revise workflow、retry 或 cancel | `sp_status` -> `sp_prepare` / `sp_start` / `sp_cancel` |
| node report failed/blocked 且 workflow 无明确 edge | controller 选择 retry/revise/cancel | `sp_status` -> `sp_start` 或 `sp_cancel` |
| node needs_user | 在主会话或当前 focused child session 向用户提问，拿到答案后恢复原 node | `sp_start(resume_input)` |
| child 无 report，只有 fallback summary | 视为部分证据，决策 retry/inspect/accept partial/cancel | `sp_status` -> `sp_start` 或 `sp_cancel` |
| 状态混乱或重启恢复后不确定 | 以 durable state 为准重新对齐 | `sp_status` |
| 用户要求停止 | 明确 scope 后取消 | `sp_cancel` |

## 9. PRD 覆盖矩阵

| PRD 需求 / 验收点 | 架构承接章节 | 覆盖方式 |
|---|---|---|
| 每个插件执行任务先 `sp_prepare` | 4.2、8 | prepare state、task brief、confirmation summary。 |
| prepare 阶段 designer 参与 | 4.2、6.2、7.2 | designer node 必须先进入 prepare-stage `workflow-spec.json`，再派发。 |
| 用户确认后才能 `sp_start` | 4.3、6.1、6.2 | `StartConfirmation` 是 `start_prepared_task` 强制输入，并落盘审计。 |
| 不支持 legacy direct start | 4.3、6.3 | direct payload 缺少 v5 三件套时拒绝；`StartConfig` 不能绕过 `WorkflowSpec`。 |
| built-in workflow / custom orchestration | 4.3、6.1、7.2 | 两类 `StartConfig` 统一规范化为 `WorkflowSpec`。 |
| workflow-spec 分阶段生成 | 4.2、4.3、6.1、6.3 | prepare/start/expansion/controller decision 都能生成或更新 spec。 |
| 每个派发 node 必须在 workflow-spec 中 | 6.3、5.3、5.8 | transition engine 先读 spec，再交给 orchestrator。 |
| workflow id 不能作为 hardcoded dispatch switch | 6.3、5.8 | built-in id 只能实例化 template。 |
| auto expansion policy | 4.4、5.3、6.1、8 | report expansion 受 policy guard 限制。 |
| 合法 expansion 先更新 spec 再派发 | 4.3、4.4、5.3、7.2 | expansion patch 写入 `workflow-spec.json` 后重新计算 runnable nodes。 |
| `needs_user` 恢复原 child session | 5.4、8 | `pending_question` + `sp_start(resume_input)`。 |
| no-report fallback 不默认成功 | 5.5、5.7、8 | fallback summary 进入 controller decision。 |
| TUI 展示 workflow 状态和动态 node graph | 5.6 | sidebar summary、session list、attention。 |
| TUI 自动聚焦 running child session | 5.6.1、5.6.2 | visual focus 与 runtime state 分离。 |
| 并行 child session 快捷键切换 | 5.6.3、5.6.4 | 快捷键展示、排序和 adapter 降级策略。 |
| public tool surface 不新增工具 | 4、5.8、8 | 保持 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。 |

未完全闭合项：

- PRD 的 TUI 验收文字仍需同步自动聚焦 child session 和 TodoWrite-style sidebar session list。
- `workflow-spec.json` 的版本号、patch diff 和 TUI diff 展示格式仍是 PRD open question，需要在实现计划中单独落地。

## 10. 当前实现差距

从现有代码看，后续实现至少需要补齐这些点：

- `src/agents/index.ts` 的 `superpowers-agent` prompt 仍强调 v4 planning-driven 固定顺序，需要替换成动态 workflow principles。
- `superpowers-agent` prompt 需要加入 prepare-first 工具协议、prepare 阶段 designer 参与判断、built-in workflow templates 和常用 workflow 示例，但明确 templates/examples 不是插件智能建议。
- `sp_prepare` 当前仍围绕固定 kind / prepare mode，需要改为 task preparation、既有 artifact persistence、confirmation summary，并支持 prepare-phase designer participation 和 prepare-stage `workflow-spec.json`。
- `sp_start` 需要支持 `prepared_task_id`、`StartConfirmation`、`StartConfig`，以及 `built_in_workflow` / `orchestration` 两类启动配置；orchestration 允许只有一个 node。
- transition 仍主要由固定 router/workflow 规则驱动，需要改为读取 `state.json`、`workflow-spec.json` 和 node result。
- 需要实现基于 `*-only` 默认值和显式 override 的 auto expansion policy，以及 `sp_report.task_graph` / `sp_report.workflow_expansion` 到 `workflow-spec.json` patch 的确定性转换。
- 需要给自动扩展增加最大节点数、允许来源 node、允许目标 agent、默认 task agent、递归深度和默认 check chain 等 guard。
- 需要在 `state.json` / `events.jsonl` 中持久化 prepare/start 状态，在 `workflow-spec.json` 和 `documents.json` 中持久化规范化 workflow 与文档 contract，并把静态能力目录、built-in templates、常用示例和 run state 分开。
- 需要实现 document contract 校验、candidate/canonical promotion 和 node-document 关联。
- 需要实现 no-report fallback summary 的检测、摘要、落盘和 controller feedback。
- TUI progress 需要按动态 node graph 展示，不再假设固定 phase。
- TUI 主内容区域需要自动聚焦当前 running child session；并行 running sessions 需要可见快捷键切换。
- `sidebar_content` 需要实时展示 workflow status、total sessions、running sessions、attention 和 TodoWrite-style session list，活跃 session 排在前面。
- 测试需要覆盖 tool 调用边界、fallback、late report、waiting_user resume、dynamic edge dispatch 和 recovery。

## 11. 设计自检

- 不把 Superpowers 理念固化为固定 workflow；controller 根据任务性质决定 prepare 行为和启动配置。
- 内置 workflow templates 和常用 workflow examples 只作为 prompt/capability 参考，不能变成插件智能规划或固定流程。
- 每个执行任务都经过 `sp_prepare`，用户确认后才 `sp_start`。
- `sp_start(start_prepared_task)` 必须携带 `prepared_task_id`、`StartConfirmation` 和 `StartConfig`，不接受 legacy direct start payload。
- `sp-designer` 的头脑风暴/设计参与发生在 prepare 阶段，不作为 start 后才开始的默认执行节点。
- prepare-phase designer 派发前必须已写入 prepare-stage `workflow-spec.json`。
- `sp_start` 可使用内置 workflow id 或自定义 orchestration；orchestration 可以只有一个 node。
- 五个 public tools 保持不变，符合 v5 PRD 的 public surface。
- controller、plugin、node agent 三者职责分开：controller 决策，plugin 执行和持久化，node agent 汇报。
- workflow artifacts 通过 `documents` contract 关联 node，生成时机、run-local path、plugin inline 传递和 promotion 规则明确。
- `sp_report` 和 fallback summary 进入同一 transition 入口，但 fallback 不默认成功。
- 用户输入、取消、恢复、late report、progress 都有明确 runtime 入口。
- progress 只做可见性，不驱动状态机。
- TUI 前台切换只改变 visual focus 和输入目标，不改变 workflow owner、parent session 或 runtime transition。
- 右侧 sidebar 能从 runtime facts 展示 workflow 状态、总会话数、运行会话数和所有会话列表；快捷键在 UI 中可见。

## 12. 后续实现建议

实现可以分五步：

1. 先改 `superpowers-agent` prompt 和 agent catalog 文档，让 controller 规划理念先对齐 v5。
2. 扩展 `sp_prepare` / state schema，支持 task preparation、既有 artifact persistence、confirmation summary、prepare-phase designer participation、prepare-stage `workflow-spec.json` 和 `documents` 注册。
3. 扩展 `sp_start` / transition，支持 `StartConfirmation`、built-in workflow id、自定义 orchestration、单节点 orchestration，以及基于 `*-only` 默认值的 auto expansion policy。
4. 改 document promotion 与 fallback runtime，使 workflow-spec、文档 contract、`sp_report` 和 fallback summary 进入统一调度入口。
5. 实现 TUI 自动聚焦、并行 session 快捷键、TodoWrite-style sidebar session list，并同步 PRD 的 TUI 验收文字。
