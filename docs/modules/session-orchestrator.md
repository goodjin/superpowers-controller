# Session Orchestrator Module

## Responsibility

session orchestrator 模块把 dispatch decision 变成 OpenCode node session。它生成插件控制的 task packet，调用 session adapter 创建或复用 session，并把 task markdown 返回给 store 写入 `nodes/*/task.md`。

orchestrator 的 dispatch/resume/notify 是提交式操作：它可以等待 `session.create()` 拿到 session id，但不能等待 `session.prompt()` 驱动的目标会话回合完成。工具调用应在 prompt 被调度后返回，后续 workflow 进展由 child session 的 `sp_report` 推动。

## Files

- `src/session/task-packet.ts`：node task packet 类型，包括 required artifact 路径和 runtime 读取后的 `source_artifacts` 正文。
- `src/session/templates.ts`：把 packet 渲染成 node prompt，并声明 primary skill、内联 source artifacts、`sp_report` contract、parent waiting-user prompt 和 child resume prompt。
- `src/session/adapter.ts`：封装 OpenCode SDK 的 `session.create`、`session.prompt`、`tui.showToast` 和 `app.log` fallback。
- `src/session/orchestrator.ts`：根据 create/reuse dispatch 调用 adapter，并封装 parent notification 与 child resume。
- `src/session/parent-progress-notifier.ts`：在 child session 已登记后，为 parent session 定时提交简短 workflow 进度提示。
- `src/router/transition.ts`：生成 orchestrator 消费的 dispatch decision。
- `src/progress/reporter.ts`：定义 dispatch progress 的稳定事件结构。

## Dispatch Contract

orchestrator 接收：

- `project`
- `runID`
- `parentSessionID`
- `decision`
- `packet`

返回：

- `action`
- `session_id`
- `task_markdown`

store 随后用这些信息创建 `node_runs`，并写入 `nodes/<node-id>/task.md` 和 `reports/<task-id>/task.md`。

orchestrator 支持 `onSessionCreated` 回调。名称保留历史兼容，但它表示“prompt 前登记”边界：无论 decision 是 `create_session` 还是 `reuse_session`，工具层都应在这个回调里先注册 `node_runs`，再由 orchestrator 调度 child prompt。这样 child session 即使立刻调用 `sp_report`，state store 里也已经有对应节点，不会出现 report 先到、node_run 还没落盘的竞态。

## Dispatch Decision Lifecycle

session orchestrator 不决定 workflow 下一步。它只执行 transition 已经产出的 `DispatchDecision`：

1. controller 或 report handler 读取 durable state。
2. `src/router/transition.ts` 根据 state 和可选 record 生成 decision。
3. session orchestrator 把 decision 转成 task packet，并以 `.opencode/superpowers/runs/<run-id>/` 为根读取 required artifacts。
4. adapter 创建或复用 OpenCode child session。
5. store 登记 `node_runs` 并写入已内联 source artifacts 的 `nodes/<node-id>/task.md` / `reports/<task-id>/task.md`。
6. parent progress notifier 在同一个 run 上启动一个 30 秒定时器。它只在 `node_runs` 已登记后启动，避免父会话看到没有 durable state 支撑的进度。
7. adapter 在后台向 child session 提交 node prompt，dispatch 方法返回。
8. child session 结束时通过 `sp_report` 回到 state/transition 层。

orchestrator 不解析 markdown、不检查 gates、不计算 runnable tasks，也不根据 agent 文本决定下一个节点。所有这些判断都必须留在 state/transition 层。

如果 create/reuse dispatch 在工具层可捕获地失败，`sp_start` 或 `sp_report` 会登记 `dispatch_failed` node，并把 workflow 放到 `waiting_user_decision`。这条状态记录是恢复依据；progress/log 里的 `dispatch_failed` 只是可见性补充。

## Decision Types

- `create_session`：为 phase/agent/task 创建一个新 child session。常见于首次派发 design、plan、implementation 或检查节点。
- `reuse_session`：复用已有 session，通常是 acceptance、verification 或 code-review failed 后，把失败上下文发回原 implementer。
- `wait_user`：不创建 session，由 controller/super-agent 向用户收集选择或补充信息。
- `blocked`：不创建 session，暴露阻塞原因。
- `finish`：不创建 session。它表示 workflow 已 direct-complete，或 `sp-finisher` 已通过 `sp_report(event="finish", status="passed")` 交回最终结果。

需要 `sp-finisher` 的 workflow 不应该返回 `finish` decision 来“隐式派发”收尾节点；它应该返回 `create_session`，并设置 `phase=finish`、`agent=sp-finisher`。如果 finish node 已创建但空跑、取消或 blocked，恢复时应重新派发 finish node 或进入 blocked recovery，而不是把 run 重新交给 entrypoint。

## Prompt Context

`buildNodeTaskPacket()` 会把 transition decision 转成可审计的 prompt packet。除 objective 和 required artifacts 外，packet 可以携带 `context_sections`：

- 有 `task_id` 的节点会包含 `Task Scope`，内容来自 `state.task_graph.tasks[]` 的同 id task。
- `acceptance` 节点会包含 `Implementation Completion Summary`，内容来自触发派发的 implementation `sp_report.summary` 和 `artifacts.patch_summary`。
- `acceptance` 节点还会包含 `Acceptance Instructions`，明确 reviewer 只检查当前 task，不因其他 task graph 项未完成而失败。
- retry 复用 implementer session 时，prompt 会包含失败检查的 `Retry Context`。

orchestrator 在渲染 prompt 前会读取 required artifacts 的正文并填入 `source_artifacts`。prompt 仍保留原始路径清单用于审计，但 node agent 不需要也不应该自行搜索 `request.md`、`spec.md`、`plan.md`、`tasks.json` 或 `reports/<task-id>/*.md`。

如果 artifact 缺失，prompt 会在 `## Source Artifacts` 中显式标记 missing。这样模型应基于缺失信息向 controller 报告阻塞，而不是扩大到项目根或全盘 `find`。

Acceptance 的 required artifacts 会指向 `spec.md`、`plan.md`、`tasks.json`、`reports/<task-id>/task.md` 和 `reports/<task-id>/report.md`。这些正文由 runtime 内联进 prompt；内联 summary 用于让检查范围在首屏 prompt 中也足够清楚。

## User Input Resume

当 child session 通过 `sp_report(status="needs_user")` 请求用户输入时，report handler 会先写入 state，再调用 `orchestrator.notifyParent()`。该方法复用 adapter 的 `session.prompt`，把等待用户输入的 controller prompt 发给 `parent_session_id` 和 `super-agent`。通知也是后台提交：child 的 `sp_report` 不应等待主会话完成提问回合。主会话负责向用户提问；插件不在 TUI 里额外创建问题面板。

用户回答后，`sp_start(run_id, resume_input)` 会调用 store 消费 `pending_question`，再通过 `orchestrator.resumeNode()` 把 resume prompt 发回原 `node_runs[].session_id`。这不是新的 dispatch decision，不创建新 child session，也不改变 task graph；它只是调度原等待节点继续执行。`sp_start` 在 resume prompt 调度后返回，不等待该 child session 完成。

## Progress Behavior

orchestrator 在每次 dispatch 时发送以下 progress：

- `dispatch_started`：准备创建或复用节点 session。
- `node_running`：节点 session 已创建或复用，task prompt 已被调度到后台提交。
- `parent_notified`：等待用户输入时，parent controller session 通知已被调度。
- `node_resumed`：原等待 child session 的 resume prompt 已被调度。
- `dispatch_failed`：后台 prompt 提交失败，adapter 通过 progress/log 暴露错误。

这些提示走 adapter 的 `showProgress()`，生产环境优先显示 TUI toast，缺失时写入 app log。

progress 只描述 dispatch 过程。它不能替代 `node_runs`，也不能驱动 transition。可捕获的 dispatch 失败必须落到 state；后台 prompt promise 的日志失败仍通过 progress/log 暴露。即使 UI 显示 child session busy/idle/stalled，workflow 是否能继续仍以 `sp_report` 写入的结构化 record 为准。

## Recovery Boundaries

恢复时不要直接调用 orchestrator。正确入口是 `sp_start`、`sp_report` 或 `sp_cancel`：

- `sp_start(run_id)` 用于用户确认恢复某个 prepared/active run；`sp_start(run_id, resume_input)` 用于恢复 `waiting_user` run 的原 child session。
- `sp_report` 用于 child node 提交结果并触发 transition。
- `sp_cancel` 用于显式取消 workflow/task/session。

这些工具会先写 state，再交给 transition/orchestrator。绕过工具直接创建 session 会让 `node_runs`、progress 和 TUI surface 失去同一个追踪源。

## E2E Behavior

生产默认行为是创建 node session 后调度 task prompt。OpenCode e2e 默认设置 `OPENCODE_SUPERPOWERS_DISABLE_CHILD_PROMPT=1`，这时 adapter 会返回一个受抑制的 synthetic session id，并跳过真正的 `session.prompt()`；state、`node_runs` 和 `nodes/*/task.md` 仍然会照常落盘。

需要验证真实节点链路时，e2e 会关闭这个开关，让 child session 正常向 mock LLM 发请求。

## Parent Session Periodic Progress

创建或复用 child session 后，orchestrator 会启动 parent progress notifier。notifier 以 run id 去重，同一个 workflow 即使连续派发多个节点，也只保留一个 30 秒定时器。

每次 tick 都重新读取当前 `WorkflowState` 和 `nodes/<node-id>/progress.jsonl`，再复用 progress panel 的摘要格式生成一条 parent prompt。prompt 明确要求 `super-agent` 只向用户输出进度，不调用工具、不推进 workflow、不要求用户确认。

notifier 只在 workflow `status=running` 且存在 `running` child node 时发送。workflow finished、canceled、blocked、failed、waiting_user、waiting_user_decision、waiting_controller_decision，或没有 running child node 时，下一次 tick 会清理定时器且不再发消息。

这条通道是用户可见性补充，不是状态机输入。它不改变 gates、不清除 pending question、不触发 transition；workflow 继续执行仍只依赖 child session 通过 `sp_report` 提交的结构化结果。

## Notes

- 节点 prompt 只声明一个 primary skill。
- 节点 prompt 由 runtime 汇总 source context；模型不负责定位 workflow artifact 文件。
- 模型不能在 `sp_report` 中提交 `next_action`、`child_session_id`、`reuse_session_id` 或 `skills_used`。
- retry dispatch 优先复用原 implementer session；无法复用时由 transition 创建新的 implementer decision。
- `test/session-orchestrator.test.ts` 断言 create-session 路径的顺序是 `create -> register -> prompt`，这是避免子会话首轮抢跑的稳定性边界；它还断言 child/parent prompt promise 不 resolve 时，dispatch、resume 和 notify 仍会返回。
