# Progress Module

## Responsibility

progress 模块定义 Superpowers Controller 的用户可见流程提示契约。它只描述 side-channel 进度事件，不参与 workflow 路由、gate 判断、task graph 调度或模型上下文注入。

## Files

- `src/progress/reporter.ts`：定义 `ProgressUpdate`、`ProgressStage`、`ProgressReporter` 和 noop reporter。
- `src/progress/node-progress.ts`：把 OpenCode child session 事件转换成节点进展记录，并读写 `nodes/<node-id>/progress.jsonl`。
- `src/status/workflow-status.ts`：把 workflow state、child progress 和推荐下一步整理成 `sp_status` 可返回的 status snapshot；当 `include_progress=true` 时额外返回主会话工具结果使用的 `progress_digest`。
- `src/tui/progress-panel.ts`：把 workflow state、节点进展和 live session status 整理成 TUI 面板 view-model。
- `src/tui.ts`：注册 `superpowers-progress` TUI route、`superpowers.progress` 命令入口，以及主会话底部/sidebar 常驻进度 slot。

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

## Delivery

生产环境由 OpenCode session adapter 发送 progress：

1. 优先调用 `ctx.client.tui.showToast({ body: update })`。
2. 如果 TUI toast 不可用，回退到 `ctx.client.app.log()`。

progress 不写入 prompt，不注入 system message，也不作为模型决策依据。

## Progress vs Workflow Transition

progress 模块处理的是用户可见提示，不是 workflow 状态机。需要区分两类名字相似但职责不同的内容：

- `ProgressUpdate.stage`：UI/log 事件，例如 `dispatch_started`、`node_running`、`node_recorded`。
- `sp_report.status = "progress"`：节点上报中间结果或心跳，允许更新 report/artifact 和 `reported_at`，但不关闭 node，也不触发下一步 dispatch。

两者都不能单独推进 workflow。workflow 继续执行只依赖 state/transition 层处理后的结构化 record，例如 `passed`、`failed`、`blocked` 或 `needs_user`。

如果 TUI 显示某个 node `stalled`，含义只是“已有登记 child session 最近没有新的 progress 事件”。这不是 runtime failure，也不是可自动跳过的 gate。用户或 controller 需要通过 `sp_status` 查看 durable state，再决定等待、取消或恢复。

## Child Session Progress

server plugin 的 `event` hook 会读取当前 workflow state，只处理 `node_runs[].session_id` 中登记过的 child session。匹配成功后，以下 OpenCode 事件会被压成简短进展：

- `message.part.updated`：记录 text、reasoning、tool、patch、step 活动。
- `session.status`：记录 busy、retry、idle 等状态。
- `session.idle`：记录当前 child turn 已空闲。
- `session.error`：记录 provider 或 runtime 错误摘要。

进展以 JSONL 追加到：

```text
.opencode/superpowers/runs/<run-id>/nodes/<node-id>/progress.jsonl
```

这些记录只服务用户可见状态面板和调试，不参与 gate 判断，也不改变 `sp_report` 的结构化完成契约。

## Main Session Tool Result

主会话里的灰色工具调用结果可以作为 child progress 的按需摘要入口，但不是实时进度主通道。

当 controller 或用户需要知道 child session 当前在做什么时，`super-agent` 应调用：

```text
sp_status(include_progress=true)
```

返回值中的 `progress_digest` 面向主会话展示：

- `delivery = "on_demand_tool_result"`：说明它只来自一次工具查询。
- `display_policy = "main_session_summary"`：说明它适合简短总结，不适合高频刷屏。
- `current_activity`：最近一条 child progress。
- `recent_activity`：按 `progress_tail` 限制后的最近 progress。
- `attention`：等待用户、等待批准、阻塞、失败、stalled 等需要优先说明的状态。

这条通道不能替代 `app_bottom`、`sidebar_content` 或 `prompt_progress`。插件也不通过 `session.prompt` 把普通进展持续注入主会话，否则会触发新的模型回合并污染 controller 上下文。只有等待用户、等待批准、阻塞、失败等关键事件才适合由 controller 在主会话里显式说明。

## TUI Surfaces

TUI entry 暴露在 package 的 `./tui` export。

完整面板 route 名为 `superpowers-progress`，命令值为 `superpowers.progress`。面板展示 active run、每个 node 的 agent、phase、task、session、durable status、live session status 和最新进展摘要。

workflow 用户输入不再通过独立 TUI question route 处理。节点需要用户输入时调用 `sp_report(status="needs_user")`，runtime 通知 parent controller session，由主会话中的 `super-agent` 询问用户，并通过 `sp_start(run_id, resume_input)` 恢复原 child session。

主会话常驻进度通过 TUI slot 展示。不同 slot 不再复用同一条 compact 文本，而是按可用空间分工：

- `app_bottom`：主会话底部常驻 surface，承载整体 workflow 状态，例如 workflow/status/current phase、任务完成数、运行中 session 数，并追加最近一个 child session 的可读活动摘要和相对更新时间。它是 session-bound slot；host 没有传入 `session_id` 时不渲染，避免首页底部显示 workflow 状态。
- `sidebar_content`：右侧栏主体，是 workflow 会话运行信息的主展示区域。OpenCode host 会传入当前 `session_id`；插件优先在该 session 属于某个 workflow 的 parent session 或 child node session 时展示 workflow 总览、运行中 child session 列表、最近活动详情，以及 waiting_user 的问题正文和候选选项。如果当前 session 是新的 `super-agent` 主控会话，但不是旧 workflow 的 parent session，允许 fallback 到最新未结束 workflow，保证重启或新开主控会话后仍能看到子会话进度。普通无关 session 继续隐藏。它不收集用户答案，也不替换 host 原生摘要。
- `sidebar_footer`：右侧栏底部降级 surface，承载整体 workflow 状态。和 `sidebar_content` 一样按 `session_id` 绑定到对应 workflow。
- `session_prompt_right`、`home_prompt`、`home_prompt_right`、`home_bottom`、`home_footer`：不注册 Superpowers resident progress。workflow 会话运行信息不放在 prompt/right 区域；`home_*` 是首页区域，不作为主会话运行态展示入口。

详细过程仍通过 `superpowers-progress` route 查看；用户输入通过主会话完成，不存在 `superpowers-questions` route。

running node 的最新 progress 如果超过显示阈值没有更新，会在 compact 行和完整面板里标为 `stalled`，例如 `SP: sp-acceptance-reviewer stalled - write pending`。`running` 和 `stalled` 是互斥展示状态：同一个 session 超时后只显示 `stalled`，不再把两个状态拼在一起。这表示 Controller 仍然有登记的 child session，但最近的 child progress 已经停住，需要用户能在主会话直接看到。

TUI 行摘要优先使用最新的可读进展事件。`session_status` 和 `session_idle` 仍作为活跃度时间来源，但不会覆盖最近的 text/tool/patch/reasoning 摘要；这样 child session 刚变成 idle 时，底部和侧栏仍会显示刚才实际做了什么，而不是只显示 `session idle`。

slot render 必须返回 OpenTUI/Solid element，而不是裸字符串。TUI 入口会加载 `@opentui/solid/runtime-plugin-support`，再使用 `@opentui/solid` 创建 `text` element，并对 workflow/progress 读取异常做 fail-closed 处理；读取失败时只显示 `SP: progress unavailable`，避免异常进入 host TUI 渲染器。

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

常驻 slot 不能依赖父会话消息流触发刷新。child session 写入 `progress.jsonl` 时，parent session 的 `time_updated` 可能不变，因此 resident surface 需要自己定时重读 workflow/progress。`app_bottom` 只在主会话页拿到 session props 后显示对应 workflow 状态；`sidebar_content` 和 `sidebar_footer` 作为 session slot 绑定到 host 传入的 session id，其中 `sidebar_content` 对 `super-agent` 主控会话允许 latest unfinished workflow fallback。无关 session 继续隐藏。

当 workflow 进入 `waiting_user` 时，`sidebar_content` 会显示 pending question 的来源节点、问题正文、最多三个候选选项，以及最近 child 活动。用户回答仍由 runtime 投递给 parent controller session 后在主会话处理，TUI slot 不承担选择框或自由输入框职责。

OpenCode 原生 Todo 面板来自 child session 的 `todowrite` tool part，和 Superpowers progress surface 是两条不同 UI 链路。看到 Todo 只能说明该 session 调用了 `todowrite`，不能说明 Superpowers resident progress 已经成功显示。
