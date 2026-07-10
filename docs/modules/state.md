# State Module

## Responsibility

state 模块负责 workflow run 的本地持久化、artifact/report 写入、task graph 规范化、node run 跟踪和 `sp_report` gate 校验。插件的关键判断读取 JSON state，不解析 markdown。

## Files

- `src/state/types.ts`：workflow、record、task graph、gate、artifact 和 `NodeRun` 类型。
- `src/state/store.ts`：读写 current pointer、run directory、state、artifacts、nodes 和 changelog；含 `markPromptDeliveryFailed`、`markSessionError`、`markNotificationFailed`。
- `src/runtime/workflow-attention.ts`：并行混合态、技术异常后的 workflow status 和 `parallel_context` 辅助逻辑。
- `src/state/transitions.ts`：把 `sp_report` 应用到 workflow state，校验 gate 和 artifact 关系。
- `src/state/record-schema.ts`：严格解析 `sp_report` 输入，拒绝 control-plane 字段。
- `src/state/task-graph.ts`：校验 task dependency、加入共享写文件隐式依赖、计算 runnable tasks。

## Run Layout

```text
.opencode/superpowers/
  current.json
  runs/<run-id>/
    state.json
    workflow.json
    workflow-spec.json
    documents.json
    sessions.json
    request.md
    task.md
    proposal.md
    events.jsonl
    changelog.md
    tasks.json
    task_graph.json
    workflow-expansion-latest.json
    artifacts/*.md
    reports/<task-id>/
      task.md
      report.md
      acceptance.md
      verification.md
      code_review.md
      finish.md
    nodes/<node-id>/
      task.md
      record.json
      output.md
      fallback-summary.json
```

## Workflow State

`WorkflowState` 保留旧 e2e 读取的 `mode`、`phase`、`session` 字段，同时新增 control-plane 字段：

- `activation`
- `prepare_mode`
- `workflow`
- `entrypoint`
- `limited_context`
- `parent_session_id`
- `current_phase`
- `status`
- `node_runs`
- `pending_question`
- `pending_workflow_expansion`
- `workflow_spec`
- `start_confirmation`
- `start_config`
- `documents`
- `fallback_summaries`
- `state_version`

其中 `activation` 用来区分：

- `draft`：planning run 已准备，但还没得到最终执行确认
- `active`：已正式进入 workflow 执行链路

字段语义：

- `workflow` 是流程定义种类，决定允许的 agent、task graph policy、检查顺序和汇总方式。
- `prepare_mode` 是旧 v4 兼容字段；v5 新判断优先使用 `workflow_spec` / `start_config`。
- `entrypoint` 是启动入口，描述用户确认从哪里进入流程；它不应覆盖 `phase/current_phase` 的恢复判断。
- `mode` 是兼容旧测试和 OpenCode mode 的粗粒度入口；新的 runtime 判断优先看 `workflow`、`entrypoint`、`current_phase`、`status` 和 `node_runs`。
- `phase` 与 `current_phase` 当前保持同义，用于 durable state、UI 和测试读取。未来如果需要保留历史兼容字段，新的判断应优先读 `current_phase`。
- `status` 是 workflow 级状态，例如 `running`、`awaiting_design_approval`、`awaiting_plan_approval`、`waiting_user`、`waiting_user_decision`、`waiting_controller_decision`、`blocked`、`failed`、`passed`、`canceled`、`recovered_unknown`。
- `pending_question` 只保存等待用户回答的问题；问题回答后必须通过 `sp_start(run_id, resume_input)` 清空并恢复原 child session。
- `pending_workflow_expansion` 保存 auto expansion policy 不允许时等待主控裁决的 `sp_report.workflow_expansion`。
- `workflow_spec` 保存 prepare-stage workflow spec，以及用户确认启动时由 `StartConfig` 选择或覆盖的内置 workflow template / 自定义 orchestration。
- `start_confirmation` 保存用户确认 prepared task 的结构化证据，例如确认摘要、确认来源 session 和确认时间。
- `start_config` 保存本次启动选择的内置 workflow id 或自定义 orchestration；runtime dispatch 以落盘后的 `workflow_spec` 为准。
- `documents` 和 run 根目录下的 `documents.json` 是 run-local artifact 索引，不是项目交付文件。
- `task_graph` 是结构化任务图。runtime 不从 `plan.md` 反推任务图。
- `state_version` 是状态版本。批准 design/plan、resume 用户输入、dispatch node、cancel 和 startup reconciliation 都会推进版本；`sp_start(expected_state_version=...)` 用它避免 stale approval。

## Prepared Context And Canonical Artifacts

draft 状态下的 prepare-stage design/plan 输出先作为 candidate context 保存：

- candidate design: `nodes/<designer-node>/record.json` 和 `output.md`
- candidate plan: `nodes/<planner-node>/record.json` 和 `output.md`

candidate 不会绕过用户确认直接启动正式执行。v5 主路径由 `sp_prepare` 生成 confirmation summary 和 prepare-stage `workflow-spec.json`，用户确认后由 `sp_start(action="start_prepared_task", confirmation, start_config)` 激活；启动时 runtime 根据 confirmed workflow spec 生成或更新 canonical artifacts、task graph 和 dispatch state。

旧 v4 candidate promotion 只保留在 `ProjectStore` 内部迁移方法里，用于读取历史 latest passed candidate 并做 canonical promotion；public `sp_start` 不再暴露 `approve_design` 或 `approve_plan`。相关测试只能覆盖内部迁移行为，不能把它描述为当前 v5 主路径。

下游 planner/implementer/checker 只消费 confirmed workflow spec 和 canonical artifacts。candidate output 只用于用户 review、controller feedback、恢复和审计。

## Record Status Semantics

`sp_report` 的 `status` 决定 state update 和 dispatch 行为：

| Status | State effect | Dispatch effect |
|---|---|---|
| `progress` | 更新 report/artifact、`reported_at` 和 history；node 保持 running。 | 不派发后续节点。 |
| `passed` | 当前 node 进入 passed/closed，gate 和 artifact 生效。 | 按 transition 计算下一步。 |
| `failed` | 当前 node 进入 failed，workflow 进入 failed。 | 检查节点失败时可回派 implementer；其他失败通常 blocked。 |
| `blocked` | 当前 node 或 workflow 进入 blocked。 | 不派发后续节点，等待用户或 controller recovery。 |
| `needs_user` | workflow 进入 `waiting_user`，写入 `pending_question`。 | 不派发后续节点；report handler 通知 parent controller session。 |

`progress` 和 `passed` 的边界很重要。planner 可以多次用 `progress` 追加 candidate plan/task graph 草稿；只有 `passed` 才表示当前 planner 输出可进入 approval decision。implementation、acceptance、verification、code-review 也遵守同样规则：中间进度不应改变派发链。

## Workflow Expansion

`sp_report` 可以携带 `workflow_expansion`：

- `tasks`：追加或替换 `task_graph` 中的结构化任务。
- `nodes`：追加或替换 `workflow_spec.orchestration.nodes`。
- `documents`：追加 run-local document registry 条目。
- `reason`：记录扩展原因，写入 history/events。

如果当前 `workflow_spec.auto_expansion.allow === true`，runtime 会应用 expansion，写入 `workflow-expansion-latest.json`、`task_graph.json` / `tasks.json`，并先 patch `workflow-spec.json`。只有 patch 后的 spec 和 task graph 持久化成功，runtime 才按 transition 派发 runnable task。任务可以通过 `agent` 指定目标 node agent；未指定时默认按 implementer 处理。

如果 auto expansion 不允许，runtime 不应用 expansion，而是把 workflow 置为 `waiting_controller_decision`，保存 `pending_workflow_expansion`，并通过 `controller_feedback.allowed_controller_decisions` 暴露 `apply_workflow_patch`、`mark_blocked`、`request_reprepare` 等裁决。

## Node Runs

每次 dispatch 创建一个 `NodeRun`：

- `id`
- `task_id`
- `phase`
- `agent`
- `primary_skill`
- `session_id`
- `status`
- `attempts`
- `started_at`
- `reported_at`
- `closed_at`
- `record_path`

`recordNodeResult()` 会把 matching node 从 `running` 更新成 `passed`、`failed`、`blocked` 或 `needs_user`；`progress` 只更新 `reported_at`，不会关闭 session run。记录会写入 `nodes/<node-id>/record.json`、`output.md` 和 `reports/<task-id>/...`。

v4 新增 node 状态：

- `dispatch_failed`：child session 创建或 prompt 投递失败；若仍有其他 `running` sibling，workflow 保持 `running` 并返回 `parallel_context`；否则进入 `waiting_controller_decision`。
- `notification_failed`：notify parent/child 失败，保留 `pending_question`，主控可用 `sp_status` + `resume_user_input` 继续。
- `notification_failed`：node 已请求用户输入，但 parent notification 失败；`pending_question` 仍是事实来源。
- `canceled`：用户取消了 node/session；workflow 不能保持无 live node 的 `running`。

matching node 的归属顺序是：显式 `nodeID`、child `sessionID`、event phase/agent 的唯一 running match、单一 running node fallback。如果仍有多个 running node，runtime 应拒绝猜测，避免并行任务的 report 写到错误 node。

`addNodeRun()` 是 runtime 确认派发新节点后的恢复点。只要 workflow 还没有 `passed` 或 `canceled`，新增 node run 会把 workflow `status` 设回 `running`，并把 `phase/current_phase` 更新为新节点 phase。这样 acceptance、verification 或 code review 失败后触发 retry implementer 时，UI 不会继续停留在 failed 状态。

插件进程启动时会启用 startup reconciliation。因为 host 进程停止后不可能继承旧 child turn，持久化 state 中遗留的 `node_runs[].status === "running"` 会被改成 `interrupted`，并设置 `closed_at/ended_at`。如果 active workflow 顶层仍是 `status === "running"`，即使没有 running node，也会被改成 `recovered_unknown`。draft prepared workflow 不属于已启动运行，不会被 startup recovery 改写。`recovered_unknown` 表示需要主控会话询问用户是恢复、取消还是先检查，不允许启动时自动重派发。TUI slot 的 store 读取保持只读，依赖插件启动时已经写回的 reconciled snapshot，避免 UI 读操作误中断仍在运行的 child。

`node_runs` 是执行事实来源：

- 是否有 active child session，看 `node_runs[].status === "running"`。
- `interrupted` 表示插件启动恢复时发现旧 running node 已不能视为 live session；它和 failed/blocked/needs_user 一样会阻塞 task graph 自动推进。
- interrupted/canceled/dispatch_failed session 的 late report 不会覆盖 current state。store 会把迟到报告写成 `late_report_ignored` 审计事件，保留旧 node 和 newer attempt 的状态。
- 一个 implementation task 是否完成，不能只看 `sp-implementer` passed；还要看同一 `task_id` 的 acceptance、verification 和 code-review 是否按 workflow policy 通过。
- finish 是否需要重派，看 finish node 是否缺少 record、是否 blocked/canceled、以及 workflow 是否已经 `passed`。
- 重试不能覆盖旧 node run，应追加 attempt 或新 node id，保留审计链。

## Question Contract

`sp_report.question.options` 的 canonical 形状是对象数组：

```ts
type QuestionOption = {
  label: string
  description?: string
}
```

模型可见的 tool schema 和 node prompt 都只展示这个对象形状，避免和 OpenCode/TUI question bridge 的 `{ label, description? }` 契约分裂。`record-schema` 仍接受历史字符串数组并归一化为 `{ label }`，只作为兼容旧调用和旧状态的解析路径，不作为新的模型提示契约。

draft plan 完成后自动生成的 `pending_question.options` 也使用同一个对象形状，避免 state 内出现第二套问题选项结构。`options` 是可选字段；没有 options 的问题表示需要用户在主会话自由输入。

`resume_input` 是用户回答进入 runtime 的结构化载体，最小字段是：

```ts
type ResumeInput = {
  source_node_id: string
  answer_text?: string
  selected_options?: string[]
  user_message?: string
}
```

`source_node_id` 必须匹配当前 `pending_question.source_node_id`。匹配后 store 会清空 `pending_question`，把对应 `node_runs[]` 从 `needs_user` 改回 `running`，并把 workflow `status` 设回 `running`、`phase/current_phase` 设回原节点 phase。

## Task Graph

`normalizeTaskGraph()` 会拒绝未知依赖，并为共享可写文件增加隐式依赖。`getRunnableTasks()` 只返回依赖已 passed、未 running、未 failed 的任务；失败任务不会启动依赖它的任务。

`finish` 记录在 `verification_fresh` 之外还会检查 `task_graph`。设计规则是：如果 run 带有 task graph，所有 graph task 都必须达到 task-level passed，workflow 才能进入 `finished/passed`。这可以防止 workflow 在 T5/T6/T7 这类任务仍未登记、未实现或未完成检查时提前结束，也避免主会话绕过 Controller 后让 TUI 失去追踪对象。

task-level passed 不是“任意同 `task_id` 的 node run passed”。它按 task 自身的 agent/phase 判断基础完成条件：

- `sp-planner` task 由 `plan` passed 满足依赖。
- `sp-designer` task 由 `design` passed 满足依赖。
- `sp-debugger` task 由 `debug` passed 满足依赖。
- `sp-investigator` task 由 `investigate` passed 满足依赖。
- checker task 由对应的 `acceptance`、`verification` 或 `code-review` passed 满足依赖。
- 未声明 agent 或普通 implementation task 继续按 workflow definition 要求的 check chain 判断，例如 feature 默认需要 implementation、acceptance、verification 和 code-review 全部 passed。
- 没有同 `task_id` 的 running、failed、blocked、needs_user 或 interrupted node 阻塞后续推进。

Transition 在 `code-review` passed 后回到 `getRunnableTasks()`，继续派发依赖已满足的后续 implementation task；如果所有 graph task 都达到 task-level passed 且没有 running node，才进入 finish。

后续如果要支持每个 task 自定义裁剪 checks，应把 task-level passed 从 `node_runs.status` 中独立出来，落到显式 task/check state 上。`node_runs` 仍保留审计事实，但不应作为唯一的 task 完成模型。

## Runtime Memory vs Durable Snapshot

runtime memory 是当前 workflow 状态的权威来源。`.opencode/superpowers/current.json` 和 `runs/<run-id>/state.json` 是 durable snapshot：它们记录插件已确认的 workflow 状态、node run、artifact path 和 task graph，用于重启恢复、审计和 TUI 跨进程降级读取，但不能直接证明 child session 此刻仍在运行。

插件进程启动时从 durable snapshot 加载 state，然后先执行 reconciliation，再初始化 runtime memory。任何从 durable 恢复出的 `node_runs[].status === "running"` 或 active workflow 顶层 `status === "running"` 都不能原样进入当前事实；node running 必须被转成 `interrupted`，workflow 顶层进入 `recovered_unknown`，等待用户决定恢复、取消或检查。draft prepared workflow 仍等待用户显式 `sp_start`，不能被当作中断。

当 running node 被标记为 `interrupted` 时，runtime 会写入 `nodes/<node-id>/fallback-summary.json`，说明该 node 没有 terminal `sp_report`，只能作为 partial evidence。`documents.json` 会索引该 fallback summary，controller 可以基于 `allowed_controller_decisions` 选择 retry、accept partial、mark blocked、request reprepare 或 cancel。

运行期所有 tool 和 transition 先读 runtime memory；状态变更先写 memory，再同步 durable snapshot。OpenCode live session status 和 progress log 只能补充“child session 当前忙/闲/最近发生过什么”等运行时信号，不能替代 runtime memory 的结构化 workflow 状态。

恢复流程基于 runtime memory 重新计算：

1. 如果 workflow `status` 是 `waiting_user`，普通 `sp_start(run_id)` 只返回等待状态，不派发节点；带 `resume_input` 的 `sp_start` 校验并恢复原 child session。
2. 如果 workflow `status` 是 `recovered_unknown`，普通 `sp_start(run_id)` 只返回恢复提示；用户确认重试后，主控用 `sp_start(run_id, task_id)` 为对应 interrupted task 创建新 attempt。
3. 如果存在 running node，先等待或由用户决定 cancel/retry。
4. 如果有 failed/blocked/interrupted node，按 workflow policy 判断能否重试或需要用户决策。
5. 如果 task graph 有 runnable task，派发 implementer。
6. 如果所有 task graph task 达到 task-level passed，派发 finish 或确认 workflow finished。
7. 如果没有 task graph 且还处于入口阶段，才回到 workflow entrypoint。

这个顺序防止已执行到后段的 workflow 被 `entrypoint` 或入口流程误判为新 run。
