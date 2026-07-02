# Controller Module

## Responsibility

controller 模块负责把用户确认后的任务整理成可准备、可启动、可恢复的 workflow 输入，并把 public tool 调用转成 runtime 能执行的状态变更。它不执行节点工作；子会话创建由 session orchestrator 负责，run 状态持久化由 state store 负责，下一步派发由 transition 规则负责。

## Files

- `src/controller/proposal.ts`：生成 workflow proposal 和 resume proposal。
- `src/controller/intake.ts`：把确认后的 proposal 转成 `startRun` 输入。
- `src/controller/feedback.ts`：生成 public tools 返回给 controller 的结构化 `controller_feedback`。
- `src/tools/sp-status.ts`：查询当前 workflow、未完成历史列表、task/session detail、progress digest；`include_capabilities=true` 时返回 v5 agent catalog、workflow schema、built-in workflow templates 和 examples。
- `src/tools/sp-prepare.ts`：创建 prepared workflow；支持 v5 `task_brief`、`design_participation`、`confirmation`，并兼容 v4 `prepare_mode`。
- `src/tools/sp-start.ts`：确认后创建 active run，批准 design/plan candidate，激活 proposal-only draft，恢复已有 run，用 `resume_input` 恢复等待用户输入的 child session，或用 v5 `start_config` 写入 `workflow-spec.json` 后启动。
- `src/tools/sp-cancel.ts`：取消 workflow、task 或 session。
- `src/tools/sp-report.ts`：节点会话汇报结果、问题、产物和 task graph。
- `src/progress/reporter.ts`：为 route/start 提供用户可见的流程提示契约。

## Public Control Surface

公开工具面只保留五个动作：

```text
sp_status -> sp_prepare -> sp_start -> sp_report(terminal/control status) -> transition
                    \-> sp_cancel
```

- `sp_status`：读取当前 active workflow、等待用户输入的 workflow、未完成历史 workflow 和 task/session 状态。它只读，不改变 runtime 状态。当前事实以 runtime memory 为准；durable 文件只作为恢复快照和审计材料出现在响应的 `durable` 区块。响应始终包含轻量 `node_summary`，用于快速判断最后节点、未完成节点、running/interrupted/blocked 节点和 task completion；需要完整 session/progress tail 时传 `detail="sessions"` 或 `detail="full"`，再配合 `include_progress=true`。遇到 `blocked`、`failed`、`waiting_user_decision`、`waiting_controller_decision`、`recovered_unknown` 或失败 node 时，返回 `allowed_controller_decisions` 供主控选择。
- `sp_prepare`：创建或更新一个 `draft` run，写入 request/task/proposal/state/documents。v5 主路径由 controller 传入 `task_brief` 和 `design_participation`；`task_brief` 的 `constraints`、`acceptance_criteria`、`known_context`、`risks` 是给后续模型读取的 prose string，不是结构化数组；`proposal_only` 不派发 child node，`managed_design` 会派发 `sp-designer` 产出 candidate design，`managed_planning` 会派发 `sp-planner` 产出 candidate plan/task graph。
- `sp_start`：在用户确认后启动 workflow。对新 run，它创建 active run 并派发入口节点；对 prepared run，它支持 `prepared_task_id`、`action="start_prepared_task"` 和 `start_config`。`start_config` 可以引用内置 workflow id，也可以提供单节点或多节点 orchestration；启动时写入 `workflow-spec.json`。对异常态，`sp_start(start_action="resolve_controller_decision", controller_decision=...)` 消费 `allowed_controller_decisions` 中的裁决。`sp_start` 派发或恢复 child prompt 后返回，不等待 child session 完整跑完。
- `sp_report`：节点 session 提交结构化结果、产物、gate、task graph、workflow expansion 或用户问题。runtime 根据 report status、transition 规则和 auto expansion policy 决定是否派发后续节点；`progress` report 只更新记录，不进入 dispatch。
- `sp_cancel`：取消 workflow、task 或 session。取消是显式状态变更，后续恢复必须读取取消后的 `node_runs` 和 workflow status。

内部历史工具名如 `sp_route`、`sp_next`、`sp_reset` 不属于新的 public loop。文档或测试如果还引用这些工具，应标注为 legacy 或迁移背景。

## Runtime Terms

- `workflow`：流程类型，例如 `feature`、`bugfix`、`debug`、`design-only`、`plan-only`、`review`、`review-only`、`verify-finish`、`parallel-investigate`、`single-agent`。
- `entrypoint`：本次 run 从哪个入口开始，例如 `feature`、`implement`、`review`、`verify`。它描述用户确认的进入口径，不等于当前阶段。
- `activation`：`draft` 表示已准备但未最终确认；`active` 表示 runtime 可以派发节点。
- `phase/current_phase`：当前 runtime 阶段，用于 UI 和恢复判断，例如 `design`、`plan-complete`、`implementation-complete`、`code-review-passed`、`finished`。
- `event`：`sp_report` 提交的节点事件，例如 `design`、`plan`、`implementation`、`acceptance`、`verification`、`code-review`、`finish`。
- `status`：workflow 或 node 的状态。node report 的 `progress`、`passed`、`failed`、`blocked`、`needs_user` 会影响是否关闭 node 以及是否触发后续 dispatch。
- `node_runs`：实际派发事实。每个 child session 必须先登记到 `node_runs`，再提交首条 node prompt。
- `task_graph`：planner 或 prepare 生成的任务图。runtime 只从结构化 graph 和 `node_runs` 计算 runnable task，不解析 markdown plan。
- `prepare_mode`：`proposal_only`、`managed_design` 或 `managed_planning`。它描述 draft preparation 的运行方式。
- `workflow_spec`：v5 启动配置落盘后的执行说明，来自内置 workflow template 或 controller 自定义 orchestration。
- `documents` / `documents.json`：run-local 文档索引，记录 request、task、proposal、spec、plan、task graph、workflow spec、node task/report 和 fallback summary。
- `pending_workflow_expansion`：auto expansion policy 不允许时保存待主控裁决的 node-reported expansion。
- `state_version`：状态版本。`sp_start(expected_state_version=...)` 用它拒绝基于旧状态的批准、恢复或 retry。
- `controller_feedback`：public tool 返回给 controller 的结构化下一步，包含 recommended next、allowed controller decisions、approval target、blocking reason 和 artifact mode。

## Control Flow

1. `super-agent` 先调用 `sp_status` 判断是否有当前 workflow 或未完成历史 workflow。
2. 新任务、需要改变任务/范围的恢复动作，或需要从 source workflow 派生新 run 时，`super-agent` 调用 `sp_prepare`，传入确认后的 `task_brief`、workflow kind、entrypoint、designer participation 和可选 source workflow。
3. `sp_prepare` 创建 `draft` run，写入 request/task/proposal/state/documents 文件。controller 决定是否在 prepare 阶段派发 designer；plan-only 默认走 `managed_planning`，轻量任务可使用 `proposal_only`。
4. managed design 的 designer passed 后，workflow 进入 `awaiting_design_approval`。用户批准时，`super-agent` 调用 `sp_start(run_id, start_action="approve_design", expected_state_version=...)`。
5. runtime 把 candidate design promotion 成 canonical `artifacts/spec.md`，记录 approval event，然后派发 planner draft。
6. planner passed 后，workflow 进入 `awaiting_plan_approval`。用户批准时，`super-agent` 调用 `sp_start(run_id, start_action="approve_plan", expected_state_version=...)`。
7. runtime 把 candidate plan/task graph promotion 成 canonical `artifacts/plan.md`、`task_graph.json` 和 `tasks.json`，再派发第一个 runnable implementation task。
8. `sp_start` 激活 prepared run 或恢复已有 run；如果传入 `start_config`，先写入 `workflow-spec.json`，再根据 workflow spec、workflow kind、entrypoint、current phase、task graph 和 node_runs 派发下一步。它只等待必要的 session 创建和 node registration，不等待 child session turn 完成。
9. 节点会话完成或需要追加中间结果时调用 `sp_report`。
10. runtime 根据 transition 规则和 auto expansion policy 派发后续节点，直到 finish、waiting_user、waiting_controller_decision、blocked、failed 或 canceled。后续派发同样是 prompt 调度后返回，不能把上游 `sp_report` 卡到下一个 child session 完成。
11. 如果节点通过 `sp_report(status="needs_user")` 请求用户输入，runtime 写入 `pending_question`、停止派发，并主动向 `parent_session_id` 投递 controller prompt。该通知调度后 `sp_report` 返回。`super-agent` 在主会话里询问用户；用户回答后，`super-agent` 调用 `sp_start(run_id, resume_input)`，runtime 清空 `pending_question` 并恢复原 child session。

## Dispatch Decision Rules

transition 是插件内的状态转移规则，不是模型提示。它的输入是当前 `WorkflowState` 和可选 `SpRecordInput`，输出只能是：

- `create_session`：创建新的 node session。
- `reuse_session`：复用已有 node session，通常用于检查失败后回派 implementer。
- `wait_user`：等待用户输入，不派发节点。
- `finish`：workflow 已完成或可直接收口，不创建新的 node session。
- `blocked`：runtime 无法安全继续。

启动和恢复是两个不同的设计场景。新 run 可以根据 workflow definition 派发入口节点；已有 run 的恢复必须从 durable state 计算下一步。如果 state 已有 `task_graph`、`node_runs` 或 finish/check 结果，runtime 不应把它当成全新的入口流程。

`sp_prepare(source_workflow_id=...)` 会把 source run 的 `task_graph` 和 markdown artifacts 复制进新的 prepared run；它不会复制 source run 的 `node_runs`。旧 node history 是旧 workflow 的执行证据，新 run 只能继承结构化上下文。

`sp_report(status="progress")` 只表示节点追加中间结果或心跳；它可以更新 artifact/report 和 `reported_at`，但不应关闭 node，也不应触发后续 dispatch。只有 `passed`、`failed`、`blocked`、`needs_user` 这类终态或控制态 report 才会进入 dispatch decision。

draft 状态下的 design/plan report 是 candidate output。它会写入 `nodes/<node-id>/record.json` 和 `output.md`，但不会写入 canonical `artifacts/spec.md`、`artifacts/plan.md` 或 `task_graph.json`。只有 `sp_start(start_action="approve_design")` 和 `sp_start(start_action="approve_plan")` 才会执行 promotion。

并行节点上报时，runtime 必须优先用 child session 的 `sessionID` 归属 `node_runs`。如果多个 running node 无法唯一匹配，runtime 应拒绝猜测，并要求显式 node id 或更明确的 session context。

Feature implementation task 的检查链是 task-scoped：

- `implementation` passed 后派发同一 `task_id` 的 `sp-acceptance-reviewer`。
- `acceptance` passed 后派发同一 `task_id` 的 `sp-verifier`。
- `verification` passed 后派发同一 `task_id` 的 `sp-code-reviewer`。
- `code-review` passed 后重新计算 task graph runnable tasks；如果还有依赖已满足的 task，继续派发 implementer，否则进入 finish。

## Workflow Definition Summary

workflow definition 决定入口节点、task graph policy、检查策略和汇总方式。当前设计按下表理解：

| Workflow | Entrypoint behavior | Task graph policy | Default check chain | Aggregation |
|---|---|---|---|---|
| `feature` | 先 design，再 plan；已有 plan/task graph 的恢复从 runnable task 或 finish 继续。 | planner generated | acceptance -> verification -> code-review | dispatch `sp-finisher`，finisher passed 后 workflow passed |
| `bugfix` | 先 debugger 记录 root cause，再进入 repair implementation。 | fixed or expansion generated | verification -> code-review | dispatch `sp-finisher`，finisher passed 后 workflow passed |
| `debug` | 先 debugger 记录 root cause，再进入 repair implementation。 | prepare or repair generated | acceptance -> verification -> code-review | dispatch `sp-finisher`，finisher passed 后 workflow passed |
| `design-only` | designer 产出 bounded design 后结束。 | none by default | none | direct finish |
| `plan-only` | planner 产出 plan/task graph 后结束。 | planner generated, persist only | none | direct finish，不派 implementer |
| `review` | 从 acceptance reviewer 开始检查既有实现。 | prepare generated or linked task | acceptance -> verification -> code-review | dispatch `sp-finisher`，finisher passed 后 workflow passed |
| `review-only` | code reviewer 产出 bounded review 后结束。 | none by default | none | direct finish |
| `verify-finish` | 从 verifier 开始做 fresh verification。 | linked task or finish task | verification, optional repair path | dispatch `sp-finisher` 或 direct finish，取决于 workflow definition |
| `parallel-investigate` | 派发 investigator，收集只读 findings。 | fixed or prepare generated | none | dispatch `sp-finisher` 汇总 findings |
| `single-agent` | 根据 `workflow-spec.json` 的第一个节点派发一个 agent。 | none by default | none | node passed 后 direct finish，除非允许 expansion |

`sp-finisher` 是一个 node agent，因此派发它时 transition 应返回 `create_session`，`phase=finish`，`agent=sp-finisher`。`finish` decision 本身不创建 session，只表示 workflow 已经达到 direct-complete 或 finish report 之后的收口边界。

## Resume And Recovery Rules

- `draft` run 激活后，phase 从等待确认态进入 active runtime；如果 draft plan 已经产出 `task_graph`，`sp_start` 应派发 runnable implementer，而不是重新派 planner。
- active run 的 `sp_start(run_id)` 是恢复动作。它必须先读取当前 state，再判断等待用户输入、blocked/canceled、running node、runnable tasks、finish retry 等情况。
- 如果 plugin startup 把旧 running node 标成 `interrupted` 并把 workflow 置为 `recovered_unknown`，runtime 同时写入 `nodes/<node-id>/fallback-summary.json` 和 `documents.json` 索引。`sp_start(run_id)` 不能自动派发；主控应先向用户确认，再用 `sp_start(run_id, task_id)` 重试指定 interrupted task，或用 `sp_cancel` 取消。
- 当所有 task graph task 都完成检查且没有 running node 时，下一步是 `sp-finisher` 或 workflow finish，不是 `sp-designer` 或 `sp-planner`。
- finish session 空跑、被取消或被标记 blocked 后，恢复动作应重新派发 finish 或进入明确 blocked recovery；不能因为 `entrypoint=implement` 就回到 feature 入口。
- 改变任务目标、范围、workflow kind 或 source workflow 的恢复，需要先重新 `sp_prepare` 生成用户可确认的 proposal；继续同一个 durable run 的恢复，使用 `sp_start(run_id)`。
- `sp_cancel(session_id)` 只取消匹配 session。它不自动补齐下一步；恢复时必须重新计算 transition。
- late report from interrupted/canceled/dispatch_failed child session 只作为审计写入，不覆盖 current state、canonical artifacts 或 newer attempt。
- dispatch 创建失败会登记 `dispatch_failed` node，并让 workflow 进入 `waiting_user_decision`，`controller_feedback.allowed_controller_decisions` 给出可执行裁决。
- `allowed_controller_decisions` 当前支持 `retry_node`、`continue_existing_graph`、`accept_partial_result`、`mark_blocked`、`request_reprepare`、`apply_workflow_patch`、`replace_orchestration`。主控必须选择其中一个并用 `sp_start(start_action="resolve_controller_decision")` 执行；插件会校验裁决是否仍适用于当前 `state_version` 和状态。
- `retry_node` 会记录 `controller_decision_retry_node` 事件，并为目标 node 的 agent 创建 fresh child session。`continue_existing_graph` 会从当前结构化 state 重新计算 transition。`apply_workflow_patch` 会应用 `pending_workflow_expansion` 或传入的 `workflow_patch`；`replace_orchestration` 会替换 `workflow_spec.orchestration`。`accept_partial_result`、`mark_blocked`、`request_reprepare` 只改变 workflow state 和审计记录，不派发 child session。
- `needs_user` 由节点通过 `sp_report` 上报。runtime 不派发后续节点，而是通知 `parent_session_id` 中的 `super-agent`。`super-agent` 只负责在主会话中向用户提问，并在用户回答后调用 `sp_start(run_id, resume_input)`；插件负责校验 `source_node_id`、清空 `pending_question`、恢复原 child session。节点 agent 不能绕过 runtime 调 OpenCode 原生 question。

## Control-Plane Invariants

- 插件是 workflow state machine 的所有者；模型不能用 prompt 自己决定下一个 node。
- `super-agent` 只负责用户交互、确认和调用 public tools，不直接做节点工作。
- 节点 agent 只处理自己的 node packet，结束时通过 `sp_report` 交回结构化结果。
- transition 只读取结构化 state、record 和 task graph；markdown artifacts 是审计和上下文，不是状态判断来源。
- 创建 child session 前必须先准备可审计 packet，session 创建后必须登记 `node_runs`，再发送 child prompt。
- public tools 不能等待 child session 或 parent notification 的完整模型回合；它们只负责状态变更、node registration 和 prompt 调度。
- progress 是 UI/log side-channel，不是 workflow transition 输入。
- `sp_status` 可以返回 durable、progress 和 live 三层信息：durable 是已加载到 runtime memory 的快照，progress 是 child session 事件日志，live 只有 host API 可访问时才代表当前内存状态；工具上下文拿不到 live API 时必须标注 unavailable，不能把 durable `running` 伪装成 live busy。
- `allowed_controller_decisions` 是插件给主控的安全边界，不是插件替主控做智能判断。插件只列出当前状态下 runtime 能执行且能落盘审计的动作；是否重试、接受部分结果、重新 prepare 或阻塞，由主控结合用户目标决定。
- 用户问 workflow 或 child session 当前进展时，`super-agent` 使用 `sp_status(include_progress=true)` 查询，并把返回的 `progress_digest` 简短总结给用户。这个 digest 是主会话灰色工具结果的按需摘要，不是实时流式进度入口。

## Notes

- public tool surface 只包含 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- `sp_prepare` 是 workflow 准备入口；`sp_start` 只启动已确认 workflow/task，不负责重新拆任务。
- `entrypoint=execute` 会启动 `feature` workflow 的执行入口。没有更具体 durable state 时，它从 `sp-implementer` 开始；已有 active run 的恢复仍由 state、node_runs 和 task graph 决定。
- proposal markdown 给用户和 super-agent 读；插件判断只依赖结构化字段。
- progress 是 side-channel UI/log 提示，不进入模型上下文，也不改变确认语义。
- 产品展示名是 `Superpowers Controller`。当前模块运行在 OpenCode adapter 上，但 controller 的职责描述不应绑定单一 harness。
