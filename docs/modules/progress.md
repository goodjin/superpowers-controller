# Progress Module

## Responsibility

progress 模块定义 Superpowers Controller 的用户可见流程提示契约。它只描述 side-channel 进度事件，不参与 workflow 路由、gate 判断、task graph 调度或模型上下文注入。

## Files

- `src/progress/reporter.ts`：定义 `ProgressUpdate`、`ProgressStage`、`ProgressReporter` 和 noop reporter。
- `src/progress/node-progress.ts`：把 OpenCode child session 事件转换成节点进展记录，并读写 `nodes/<node-id>/progress.jsonl`。
- `src/tui/progress-panel.ts`：把 workflow state、节点进展和 live session status 整理成 TUI 面板 view-model。
- `src/tui/question-bridge.ts`：读取 OpenCode pending question API，过滤 active workflow 的 child session question，并生成 TUI reply/reject action。
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
- `node_recorded`：节点通过 `sp_record` 写入结果。
- `waiting_user_input`：节点请求用户输入。
- `workflow_blocked`：workflow 进入阻塞状态。
- `workflow_finished`：workflow 完成。
- `dispatch_started`：准备创建或复用节点 session。
- `node_running`：节点 session 已创建或复用，task prompt 已提交。

## Delivery

生产环境由 OpenCode session adapter 发送 progress：

1. 优先调用 `ctx.client.tui.showToast({ body: update })`。
2. 如果 TUI toast 不可用，回退到 `ctx.client.app.log()`。

progress 不写入 prompt，不注入 system message，也不作为模型决策依据。

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

这些记录只服务用户可见状态面板和调试，不参与 gate 判断，也不改变 `sp_record` 的结构化完成契约。

## TUI Surfaces

TUI entry 暴露在 package 的 `./tui` export。

完整面板 route 名为 `superpowers-progress`，命令值为 `superpowers.progress`。面板展示 active run、每个 node 的 agent、phase、task、session、durable status、live session status 和最新进展摘要。

child question bridge route 名为 `superpowers-questions`，命令值为 `superpowers.questions`。它读取 OpenCode 的 pending question API，只展示 active workflow 中 `node_runs[].session_id` 拥有的问题，并提供每个选项的 `Reply` action 和一个 `Reject question` action。

主会话常驻进度通过 TUI slot 展示。不同 slot 不再复用同一条 compact 文本，而是按可用空间分工：

- `app_bottom`：主会话底部常驻 surface，承载整体 workflow 状态，例如 workflow/status/current phase、任务完成数、运行中 session 数。
- `home_bottom`：首页底部 surface，承载同一类整体 workflow 状态。
- `sidebar_content`：右侧栏主体。没有 session props 时按首页场景展示未完成任务；有 parent/child session props 时按主会话场景展示运行中的 child session 列表。
- `sidebar_footer`：右侧栏底部降级 surface，承载整体 workflow 状态。
- `session_prompt_right`：短 fallback indicator，限制为 44 字符，避免主会话没有任何可见 progress 锚点。完整内容不放在输入区。
- `home_prompt_right`、`home_footer`：不注册 Superpowers compact progress。`home_prompt_right` 会靠近输入区，`home_footer` 与 host footer 区域语义不稳定，先交给主会话底部、sidebar surface 和短 fallback 承载。

当前没有在本机 OpenCode TUI 包中确认到可用的主会话内容区 slot 名称，所以进行中会话的详细过程仍通过 `superpowers-progress` route 查看；待 host 暴露明确的 session content slot 后，再把详细过程挂到该 surface。`session_prompt_right` fallback 会截短，只做可见锚点。

running node 的最新 progress 如果超过显示阈值没有更新，会在 compact 行和完整面板里标为 `stalled`，例如 `SP: sp-spec-reviewer running/busy/stalled - write pending`。这表示 Controller 仍然有登记的 child session，但最近的 child progress 已经停住，需要用户能在主会话直接看到。

slot render 必须返回 OpenTUI/Solid element，而不是裸字符串。TUI 入口会加载 `@opentui/solid/runtime-plugin-support`，再使用 `@opentui/solid` 创建 `text` element，并对 workflow/progress 读取异常做 fail-closed 处理；读取失败时只显示 `SP: progress unavailable`，避免异常进入 host TUI 渲染器。

常驻 slot 不能依赖父会话消息流触发刷新。child session 写入 `progress.jsonl` 时，parent session 的 `time_updated` 可能不变，因此 compact surface 需要自己定时重读 workflow/progress。slot 没有传入 session props 时展示当前 active workflow；传入 session props 时，只在当前 session 属于 active workflow 时展示，包括 parent session 和 `node_runs[].session_id` 中登记过的 child session；无关 session 继续隐藏。

当 OpenCode pending question API 返回 child session question 时，compact slot 优先显示问题摘要，例如 `SP Q: Finish action - ...`；没有 pending question 时再显示普通 child progress。问题正文、选项和确认/取消动作在 `superpowers-questions` route 中完成，避免把交互塞进一行状态文本。

OpenCode 原生 Todo 面板来自 child session 的 `todowrite` tool part，和 Superpowers progress surface 是两条不同 UI 链路。看到 Todo 只能说明该 session 调用了 `todowrite`，不能说明 Superpowers resident progress 已经成功显示。
