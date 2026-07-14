# Progress Module

## Responsibility

progress 模块定义 Superpowers Controller 的用户可见流程提示契约。它只描述 side-channel 进度事件，不参与 workflow 路由、gate 判断、task graph 调度或模型上下文注入。

## Files

- `src/progress/reporter.ts`：定义 `ProgressUpdate`、`ProgressStage`、`ProgressReporter` 和 noop reporter。
- `src/progress/node-progress.ts`：把 OpenCode child session 事件转换成节点进展记录，并读写 `nodes/<node-id>/progress.jsonl`。
- `src/status/workflow-status.ts`：把 workflow state、child progress 和推荐下一步整理成 `sp_status` 可返回的 status snapshot；当 `include_progress=true` 时额外返回主会话工具结果使用的 `progress_digest`。
- `src/tui/progress-panel.ts`：把 workflow state、节点进展和 live session status 整理成 TUI 面板 view-model。
- `src/tui/live-activity.ts`：从 TUI `api.state.session.messages` 读取 child 最新 tool 活动，生成原生 Task 卡片风格的 `↳ Tool title` 摘要。
- `src/tui/host-sessions.ts`：从 `api.client.session.list()` 或 `session.get/status` 加载 OpenCode 会话总览；有 workflow 时 sidebar 只刷新 workflow 相关 session id；`session.list` 最多处理 32 条并带 2s 超时。
- `src/tui/sidebar-model.ts`：sidebar 结构化 view-model 与文本 fallback（`renderSidebarViewModelText`）。
- `src/tui/sidebar-debug.ts`：sidebar 诊断日志（startup 心跳默认写出；细日志需 `SUPERPOWERS_SIDEBAR_DEBUG=1`）。`tui.json(c)` 的 plugin 条目必须是包名 `superpowers-controller`，不要写 `.../tui`（会被当成 GitHub 仓库）。
- `src/tui/sidebar-view.tsx`：sidebar JSX 组件（`<For>` 列表 + `SessionListRow`），对齐 OpenCode TodoWrite 渲染模式。
- `package.json` 的 TUI build 必须把 `solid-js` / `solid-js/store` 设为 external；若被打进 `solid-js/dist/server.js`，sidebar 与常驻 slot 将失去响应式刷新。

## Event Shape

每条 progress update 包含：

- `stage`：稳定的阶段名，供测试和 UI 识别。
- `title`：短标题。
- `message`：用户可读的当前流程状态。
- `variant`：`info`、`success`、`warning` 或 `error`。

## Current Stages

- `waiting_user_confirmation`：proposal 或 resume proposal 已生成，等待用户确认。
- `run_started`：用户确认后的 workflow run 已创建。
- `node_recorded`：节点通过 `sp_report` 写入结果。
- `waiting_user_input`：节点请求用户输入。
- `workflow_blocked`：workflow 进入阻塞状态。
- `workflow_finished`：workflow 完成。
- `dispatch_started`：准备创建或复用节点 session。
- `node_running`：节点 session 已创建或复用，task prompt 已提交。
- `node_resumed`：等待用户输入的节点 session 已收到用户回答并继续运行。
- `parent_notified`：parent controller session 已收到等待用户输入的 controller prompt。
- `run_resumed`：`sp_start(run_id, resume_input)` 已恢复 workflow。
- `tui_session_select_failed`：TUI foreground session 选择失败或不可用，workflow dispatch 不因此失败。

## Delivery

生产环境由 OpenCode session adapter 发送 progress：

1. 优先调用 `ctx.client.tui.showToast({ body: update })`。
2. 如果 TUI toast 不可用，回退到 `ctx.client.app.log()`。

普通 progress 不写入 prompt，不注入 system message，也不作为模型决策依据。

## Progress vs Workflow Transition

progress 模块处理的是用户可见提示，不是 workflow 状态机。需要区分两类名字相似但职责不同的内容：

- `ProgressUpdate.stage`：UI/log 事件，例如 `dispatch_started`、`node_running`、`node_recorded`。
- `sp_report.status = "progress"`：节点上报中间结果或心跳，允许更新 report/artifact 和 `reported_at`，但不关闭 node，也不触发下一步 dispatch。

两者都不能单独推进 workflow。workflow 继续执行只依赖 state/transition 层处理后的结构化 record，例如 `passed`、`failed`、`blocked` 或 `needs_user`。

如果 TUI 显示某个 node `stalled`，含义只是“已有登记 child session 最近没有新的 progress 事件”。这不是 runtime failure，也不是可自动跳过的 gate。用户或 controller 需要通过 `sp_status` 查看 durable state，再决定等待、取消或恢复。

如果 OpenCode live session status 是 `waiting_permission`，TUI 常驻进度会显示为 `waiting permission`，并在 `sidebar_content` 的 session summary 中计数。实际 permission request 仍归属 child session id；这个进度提示负责把“子会话正在等授权”暴露到主控会话可见区域。

## Child Session Progress

server plugin 的 `event` hook 会读取当前 workflow state，只处理 `node_runs[].session_id` 中登记过的 child session。匹配成功后，以下 OpenCode 事件会被压成简短进展：

- `message.part.updated`：记录 text、reasoning、tool、patch、step 活动。
- `session.status`：记录 busy、retry、idle 等状态。
- `session.idle`：记录当前 child turn 已空闲。
- `session.error`：记录 provider 或 runtime 错误摘要；plugin event hook 同时调用 `markSessionError` 闭合假 `running` node。
- **liveness monitor**：默认每 15s 检查一次，若 `running` node 的 progress（或 `started_at`）超过 60s 无更新，则标 `interrupted` 并写入 `liveness_timeout` 事件。TUI `stalled` 阈值仍为 30s，只负责早提示，不负责 state 降级。

进展以 JSONL 追加到：

```text
.opencode/superpowers/runs/<run-id>/nodes/<node-id>/progress.jsonl
```

这些记录只服务用户可见状态面板和调试，不参与 gate 判断，也不改变 `sp_report` 的结构化完成契约。

## Main Session Tool Result

主会话里的灰色工具调用结果可以作为 child progress 的按需摘要入口，但不是自动周期性进度通道。

当 controller 或用户需要知道 child session 当前在做什么时，`superpowers-agent` 应调用：

```text
sp_status(include_progress=true)
```

返回值中的 `progress_digest` 面向主会话展示：

- `delivery = "on_demand_tool_result"`：说明它只来自一次工具查询。
- `display_policy = "main_session_summary"`：说明它适合简短总结，不适合高频刷屏。
- `current_activity`：最近一条 child progress。
- `recent_activity`：按 `progress_tail` 限制后的最近 progress。
- `attention`：等待用户、等待批准、阻塞、失败、stalled 等需要优先说明的状态。

这条按需查询通道不能替代 `sidebar_content`。TUI 仍是常驻可见 surface；dispatch/resume 后 orchestrator 会切到 child session，让用户直接观察 live transcript。等待用户、等待批准、阻塞、失败等关键事件仍由 controller 在主会话里显式说明。

## TUI Surfaces

TUI entry 暴露在 package 的 `./tui` export。v5 目标是让主内容区域尽量自动聚焦当前 running child session，同时把 workflow 控制面的关键信息常驻在 sidebar：workflow summary、total/running session counts、TodoWrite-style session list 和 shortcut hints。

完整面板 route 名为 `superpowers-progress`。面板展示 active run、每个 node 的 agent、phase、task、session、durable status、live session status 和最新进展摘要。插件还会注册 parent 和 child session command，命令语义是切换当前 OpenCode session route；切到 child 后仍必须保持 prompt 可交互并显示该 child 的实时会话内容。

orchestrator 会请求 OpenCode TUI 切到刚创建、复用或 resume 的 child session。`resumeNode()` 在调度 resume prompt 后同样调用 `selectSession`，避免用户回答 `needs_user` 后仍停留在 parent route。workflow node session 在 OpenCode 层创建为普通 session，不使用原生 `parentID` child route，以便 host 保留普通 session 的底部输入框、右侧 sidebar 和 live transcript。TUI 插件在 `session_prompt` slot 中显式渲染 `api.ui.Prompt({ sessionID: childID })`，保证 foreground child route 的底部输入框继续提交到该 child session；如果 host 没有成功切到 child，parent session 上也可以把 prompt 降级绑定到当前 foreground child。

workflow 用户输入不再通过独立 TUI question route 处理。节点需要用户输入时调用 `sp_report(status="needs_user")`。如果问题来自 foreground design/plan child，runtime 会把问题 prompt 投回当前 child session；如果问题来自 parent-led 或并行阶段，runtime 通知 parent controller session，由主会话中的 `superpowers-agent` 询问用户，并通过 `sp_start(run_id, resume_input)` 恢复原 child session。

主会话常驻进度通过 TUI slot 展示。不同 slot 不再复用同一条 compact 文本，而是按可用空间分工：

- `sidebar_content`：右侧栏主体，**唯一的会话状态常驻面**。**无 workflow 且仅 1 个会话在运行**时，顶部显示会话标题，下方显示当前动作（`thinking…` / `calling Tool …` / `last Tool …` / `waiting permission`），不展示会话列表。**有 workflow 时**排版收敛为：`SP <workflow> · <phase>` 短标题；每个 child 两行（`● [⌘n] agent  status` + 缩进活动摘要，不带 node/session id）；下方接 host **Sessions** 列表承载 live tool 活动。不再堆 `foreground child`/`recent` thinking transcript，也不再重复 `selectors`/`sessions total` 计数行。活动文案区分进行中（`calling`）与最近完成（`last`）；读不到 live status 时显示 `idle`。订阅 `api.event.on(...)` 刷新，1s 轮询兜底。
- `session_prompt`：当当前 session 是 foreground/running child，或当前 session 是 `parent_session_id` 且存在 foreground/running child 时注册有效内容。它使用 OpenCode TUI 的 `api.ui.Prompt({ sessionID: childID })` 保持底部输入区域并把提交目标绑定到当前 foreground child。不要传字符串 `hint`——宿主会把它当 box 下的裸 text node，触发 OpenTUI orphan text 崩溃；agent 提示走 `placeholders`。没有 foreground child 或没有 `api.ui.Prompt` 时返回空。
- `app_bottom`：不再注册（主区底部不再叠会话状态；可用 renderer 仅保留供调试/测试）。
- `session_prompt_right`、`home_prompt`、`home_prompt_right`、`home_bottom`、`home_footer`：不注册 Superpowers resident progress。workflow 会话运行信息不放在 prompt/right 区域；`home_*` 是首页区域，不作为主会话运行态展示入口。

详细过程仍通过 `superpowers-progress` route 查看；用户输入由 foreground child prompt binding 或 parent controller prompt 承接，不存在 `superpowers-questions` route。

running node 的最新 progress 如果超过显示阈值没有更新，会在 compact 行和完整面板里标为 `stalled`，例如 `SP: sp-acceptance-reviewer stalled - write pending`。`running` 和 `stalled` 是互斥展示状态：同一个 session 超时后只显示 `stalled`，不再把两个状态拼在一起。这表示 Controller 仍然有登记的 child session，但最近的 child progress 已经停住，需要用户能在主会话直接看到。

当 child session live status 是 `waiting_permission` 时，TUI 行摘要优先显示 `waiting permission`，优先级高于 stalled。这样用户能区分“模型长时间无进展”和“OpenCode 正在等权限确认”。

插件事件 hook 会记录 child `session.status` 变化；当已登记 child 进入 `waiting_permission` 时，会再次请求 OpenCode TUI 切到该 child session，并发出 warning toast。这条二次聚焦用于覆盖 dispatch 后用户切走、host 未执行前一次 session select、或旧版本派发的 child 后续才触发权限确认的情况。

TUI 行摘要优先使用最新的可读进展事件。`session_status` 和 `session_idle` 仍作为活跃度时间来源，但不会覆盖最近的 text/tool/patch/reasoning 摘要；这样 child session 刚变成 idle 时，底部和侧栏仍会显示刚才实际做了什么，而不是只显示 `session idle`。

slot render 必须返回 OpenTUI/Solid element，而不是裸字符串。当前 `sidebar_content` 默认走 `createTextElement` + `renderSidebarViewModelText()`（数据在 `src/tui/sidebar-model.ts`），避免把未用 `@opentui/solid/bun-plugin` 编译的 TSX 打进 `dist/tui.js`——否则会落到 `jsxDEV`/`jsx-runtime.d.ts`，整包 TUI 插件在 import 阶段失败且写不出诊断日志。`src/tui/sidebar-view.tsx` 仍保留作后续 JSX 组件化参考，恢复前必须先修好生产构建。TUI 入口会加载 `@opentui/solid/runtime-plugin-support`，并对 workflow/progress 读取异常做 fail-closed 处理；读取失败时只显示 `SP: progress unavailable`。resident slot registration 必须带 `id: "superpowers-controller"` 与 `order: 600`，以满足 OpenCode TUI slot runtime 对 plugin id 的校验，并排在内置 todo(400)/files(500) 之后。

OpenTUI slot renderer 的类型是 `(ctx, props)`，但 host/runtime 版本可能把 merged props 放在第一个参数。resident slot 读取 session 时必须同时兼容 `props.session_id`、`props.sessionID`、`ctx.session_id`、`ctx.sessionID` 和 `ctx.session.id`。如果只读第二个参数，`sidebar_content` 会在某些 host 路径拿不到当前 session，从而误判为无关 session 或退回全局 workflow。

TUI 读取 workflow/progress 时只在 host 当前目录和明确配置的 workflow project 中查找，不扫描用户磁盘。候选 project 包括：

- `SUPERAGENT_PROJECT_DIR`
- `OPENCODE_SUPERPOWERS_PROJECT_DIR`
- `SUPERAGENT_ROOT/project`
- 隔离运行时 `HOME` 的相邻 `project` 目录

resolver 不再简单返回第一个 `current.json`。选择规则是：

1. 如果 slot 传入 `session_id`，优先选择包含该 session 的 workflow。匹配范围包括 `parent_session_id` 和 `node_runs[].session_id`。
2. 如果没有 session 匹配，选择候选 project 中 `updated_at` 最新的未结束 workflow。未结束状态包括 `intake`、`running`、`awaiting_design_approval`、`awaiting_plan_approval`、`waiting_user`、`waiting_user_decision`、`waiting_controller_decision`、`blocked`、`failed` 和 `recovered_unknown`。
3. 如果没有未结束 workflow，选择 `updated_at` 最新的历史 workflow，用于 route/诊断展示。

找到 fallback workflow 时，进度 route 会附带一行 `SP: using workflow state from ...` 诊断；没有找到 workflow 时，compact/global 可见 surface 显示 `SP: no workflow state in ...`，避免工作流仍在运行但 UI 静默空白。

常驻 slot 不能依赖父会话消息流触发刷新。child session 写入 `progress.jsonl` 时，parent session 的 `time_updated` 可能不变，因此 resident surface 需要自己定时重读 workflow/progress。`sidebar_content` 会优先绑定 host 传入的 session id，找不到匹配时 fallback 到 latest unfinished workflow。严格的无关 session 隐藏只适用于 compact/session-specific 渲染，不适用于这些 resident surface，否则新主控会话或 host 缺少 agent 字段时会完全空白。

`sidebar_content` 的列表结构向 OpenCode 原生 TodoWrite 的可扫读形态靠拢，但数据源仍然是 Superpowers workflow state。短标题后直接列已创建的 child（active 优先），再列 `planned` 未派发任务。child 行只保留 shortcut、agent、task、状态与一条活动摘要；完整 session id 与 node id 不进侧栏正文。

当 workflow 进入 `waiting_user` 时，`sidebar_content` 会显示问题正文、最多三个选项标签，以及相关 child 的短状态行。用户回答由 runtime 选择的 foreground target 处理：design/plan foreground child 通过 parent session 的 `session_prompt` slot 提交到 child；其他阶段回 parent controller session。

OpenCode 原生 Todo 面板来自 child session 的 `todowrite` tool part，和 Superpowers progress surface 是两条不同 UI 链路。看到 Todo 只能说明该 session 调用了 `todowrite`，不能说明 Superpowers resident progress 已经成功显示。
