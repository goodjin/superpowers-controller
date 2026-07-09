# Agents Module

## Responsibility

agents 模块负责注入 Superpowers Controller 的 OpenCode agent 配置。`superpowers-agent` 是主会话控制器；节点 agent 只执行当前节点，并按 router 指定的 primary skill 工作。

## Files

- `src/agents/index.ts`：生成 `superpowers-agent` 和所有 `sp-*` 节点 agent 的配置。
- `src/router/modes.ts`：维护 workflow mode、phase、agent、primary skill、gate 和 next action 的映射。

## Agent Catalog

| Agent | Mode | 用途 | 适用场景 | Primary skill |
|---|---|---|---|---|
| `superpowers-agent` | `primary` | 主会话控制器，确认用户意图、恢复或创建 workflow state，并通过插件工具推进调度。 | 用户选择 `superpowers-agent` 启动、继续、查看或推进 Superpowers workflow 时。 | 无。控制器不加载业务 skill。 |
| `sp-designer` | `subagent` | 设计和 spec 节点，澄清改动形状并产出设计产物。 | `design` mode；需要在实现前明确需求、方案、边界和验收条件时。 | `superpowers-brainstorming` |
| `sp-planner` | `subagent` | 计划节点，把已确认需求转成 implementation plan 和 `depends_on` task graph。 | `plan` mode；已有 spec 或需求，需要拆成可执行任务和依赖关系时。 | `superpowers-writing-plans` |
| `sp-debugger` | `subagent` | 调试节点，先调查症状并记录 root cause，再允许修复工作开始。 | `debug` mode；遇到 bug、测试失败或异常行为，需要先定位原因时。 | `superpowers-systematic-debugging` |
| `sp-investigator` | `subagent` | 只读调查节点，读取一个独立问题域并返回 findings，不修改文件。 | `parallel-investigate` mode；多个独立领域可以并行调查，或需要把研究工作隔离到子会话时。 | `superpowers-dispatching-parallel-agents` |
| `sp-implementer` | `subagent` | 实现节点，执行一个已分配任务，按 TDD 记录证据和补丁摘要。 | `execute` mode；已有计划和任务，需要写测试、实现、记录结果时。 | `superpowers-test-driven-development` |
| `sp-acceptance-reviewer` | `subagent` | acceptance review 节点，检查实现是否满足确认后的任务、spec、plan 和验收口径。 | 实现完成后的第一段检查；先确认做的是不是用户要的。 | `superpowers-requesting-code-review` |
| `sp-code-reviewer` | `subagent` | code review 节点，检查回归风险、质量问题、测试缺口和可维护性。 | verification 通过后再做代码质量审查。 | `superpowers-requesting-code-review` |
| `sp-verifier` | `subagent` | 验证节点，重新运行验证命令并记录命令证据。 | `verify-finish` mode；完成声明、提交或交付前需要 fresh verification 时。 | `superpowers-verification-before-completion` |
| `sp-finisher` | `subagent` | 收尾节点，只在验证通过后准备最终交付。 | workflow 已完成实现、审查和验证，需要决定交付、分支或清理动作时。 | `superpowers-finishing-a-development-branch` |

## Agent Mode Mapping

这张表只描述 OpenCode mode / primary agent 的映射，不是完整 workflow definition。完整 workflow chain、task graph policy、checks 和 aggregation 规则由 controller/transition 文档描述。

| Mode | Initial phase | Primary agent | Typical report gates | Runtime role |
|---|---|---|---|---|
| `idle` | `clarify` | `superpowers-agent` | 无 | 澄清意图、检测现有 workflow state，并在 dispatch 前请求用户确认。 |
| `design` | `explore` | `sp-designer` | `design_approved`, `spec_written` | 创建 design/spec artifact 并记录 design gates。 |
| `plan` | `write-plan` | `sp-planner` | `plan_written` | 写 implementation plan 和 task graph artifact。 |
| `execute` | `run-task` | `sp-implementer` | `red_test_seen`, `implementation_done` | 执行一个可运行 task，按 TDD 记录证据。 |
| `debug` | `find-root-cause` | `sp-debugger` | `root_cause_found` | 找到并记录 root cause，再让 runtime 决定是否进入修复。 |
| `parallel-investigate` | `investigate` | `sp-investigator` | findings/report artifact | 对一个独立问题域做只读调查。 |
| `review` | `acceptance` | `sp-acceptance-reviewer` | `acceptance_passed` | 执行 acceptance 节点；后续 verification/code-review 由 transition 派发。 |
| `verify-finish` | `fresh-verification` | `sp-verifier` | `verification_fresh` | 运行 fresh verification；失败时由 transition 决定 repair path。 |

## Runtime Authority Boundary

agent prompt 不能成为 workflow state machine。职责边界如下：

- `superpowers-agent` 理解用户意图、调用 `sp_status` 读取状态、向用户确认 proposal/recovery action，然后调用 `sp_prepare`、`sp_start` 或 `sp_cancel`。
- 每个新的 `superpowers-agent` 会话第一轮 assistant 回复必须先输出固定欢迎语：`欢迎使用superpowers主控插件，我将按superpowers工作流程完成您的任务。` 这通过 `src/agents/index.ts` prompt 约束实现；插件当前不直接注入 assistant message。
- `superpowers-agent` 可以解释 runtime 返回的 state 和 dispatches，但不能根据自然语言自行创建 child session 或跳过 transition。
- `superpowers-agent` 需要能力目录时调用 `sp_status(include_capabilities=true)`，读取 agent catalog、workflow schema、built-in workflow templates 和 examples。
- 每个执行任务先 `sp_prepare`，再由用户确认后 `sp_start(action="start_prepared_task", prepared_task_id, start_config)`；`start_config` 可选内置 workflow id 或自定义 orchestration。
- `superpowers-agent` 收到 `waiting_user` / `pending_question` controller prompt 后，只负责在主会话里问用户；用户回答后调用 `sp_start(run_id, resume_input)`，不能替用户决定答案。
- 节点 agent 只读取 node task packet 中给出的 scope、artifacts 和 required outputs。
- 节点 agent 结束当前节点时调用 `sp_report`。它不能在 report 里提交 `next_action`、`child_session_id`、`reuse_session_id` 或自造 workflow transition。
- planner 或其他 node 可以提交 `task_graph` 或 `workflow_expansion`，但 runtime 负责校验依赖、共享写文件隐式依赖、auto expansion policy 和 runnable task。
- implementer、reviewer、verifier 和 finisher 不能把 UI progress、Todo 状态或口头完成声明当成 gate；gate 必须通过 `sp_report` 的结构化字段和 artifacts 落盘。

`entrypoint` 只影响 run 的初始入口或用户确认的恢复意图。已有 active run 的下一步由 durable state、`node_runs`、task graph 和 transition 规则决定，不能只因为 `entrypoint=implement` 就重新派发 designer/planner 或 implementer。新 feature run 使用 `entrypoint=execute` 且没有更具体 durable state 时，入口 agent 是 `sp-implementer`。

## Skill Boundary

- `superpowers-agent` 不加载业务技能，也不执行节点工作。
- `superpowers-agent` 禁用 `tools.skill`，并通过 `tool.execute.before` 硬阻断 native `skill` 调用，避免全局 skill 进入控制器上下文。
- `superpowers-agent` 禁止调用原生 `task` tool，并通过 `permission.task = deny`、`tools.task = false` 和 `tool.execute.before` 三层限制；子会话只能由 `sp_start` / `sp_report` 驱动的 Controller dispatch 创建，保证 `state.node_runs` 先登记再发送 child prompt。
- 对 planning-driven workflow，`superpowers-agent` 负责 `sp_status -> sp_prepare -> user confirm -> sp_start` 这一段控制链。
- 节点 agent 保留 `skill` tool，但 `permission.skill` 只允许 router 分配的 primary skill，并拒绝其它全局 skill。
- 即使外部插件或全局 permission 放宽了 native `skill` 权限，`tool.execute.before` 也会限制节点 agent 只能加载 `src/router/modes.ts` 分配的 primary skill。
- 节点 agent 也禁止嵌套调用原生 `task` tool，避免节点绕过 Controller 继续派生未登记子会话。
- 节点 agent 禁止调用 OpenCode 原生 `question` tool，并通过 `permission.question = deny` 和 `tools.question = false` 隐藏入口。需要用户输入时只能调用 `sp_report`，使用 `status: "needs_user"` 和结构化 `question` 字段；runtime 负责写入 `pending_question`、通知主控会话，并等待 `sp_start(run_id, resume_input)` 恢复原 child session。
- 节点 agent prompt 只声明一个 primary skill；需要其他 skill 时，由控制器创建或复用另一个节点 session。
- Runtime system 注入只对 `node_runs.session_id` 匹配的 child node session 生效。父级 `superpowers-agent` 会话不注入 `agent: sp-*` 或 `primary_skill`，避免控制器误认为自己正在执行节点 skill。

## Permission Inheritance

`src/plugin.ts` resolves the host OpenCode `permission` value and passes it into `createAgentConfig`. If the config hook input omits `permission`, `src/config/permissions.ts` reads the active OpenCode config from `XDG_CONFIG_HOME` or `HOME`.

Plugin-generated agents inherit the host's current permission posture before Superpowers-specific overrides are applied. This includes granular permission objects such as `external_directory: { "/tmp/*": "allow" }`, `edit: { "src/**": "allow", "*": "ask" }`, or command-pattern rules under `bash`. The plugin should not turn a user-visible allow rule back into a repeated workflow prompt.

OpenCode's runtime `Always` approval is still owned by OpenCode. If OpenCode exposes the approved rule through the config hook or active config, Superpowers agents inherit it. If OpenCode keeps the approval only in runtime memory and does not expose it to plugins, the plugin cannot persist or recover that rule after restart; for stable cross-session behavior, put the rule in OpenCode config.

When global `permission` is not `"allow"` and no granular host rule overrides a permission, agents keep the default workflow boundaries:

- `superpowers-agent` cannot edit files directly, asks before bash, cannot use native `task`, and has `tools.skill` disabled.
- Node agents ask or deny edits according to their role, allow bash after workflow dispatch, deny nested tasks, deny native child questions, and can load only their primary skill.

Node agents allow `bash` by default after workflow dispatch. The workflow start/approval step is the user confirmation boundary, and repeated child-shell probes should not strand the user in per-command prompts. File edits still use the existing agent-specific `edit` policy, verifier/reviewer/investigator agents remain read-only, and the plugin gate layer still evaluates workflow gates such as `design_approved`, `plan_written`, and `red_test_seen`.

When global `permission` is `"allow"`, plugin agents inherit that posture for read, edit, bash, external directory, plan, and related OpenCode permission points. The same inheritance applies to granular host permission objects. The exceptions are native `task` and child native `question`: `superpowers-agent` and node agents still deny the native `task` tool because child session creation is a Superpowers control-plane responsibility, and node agents deny native `question` because user-input requests must be recorded through `sp_report needs_user`. `superpowers-agent` keeps native `question` permission for controller-level clarification and denies `skill`; node agents keep skill access so they can load their assigned primary skill or any host-allowed skill rule.

## Notes

- `src/router/modes.ts` 是 agent 到 primary skill 的运行时真相；文档变更需要和该文件同步。
- `src/agents/index.ts` 是 agent prompt、permission 和 OpenCode mode 的运行时真相。
- review workflow 当前用 `sp-acceptance-reviewer` 作为 mode 入口；acceptance、verification、code review 的串行推进由 transition 和后续 dispatch 决定。
