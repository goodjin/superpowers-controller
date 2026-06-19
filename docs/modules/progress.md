# Progress Module

## Responsibility

progress 模块定义 Superpowers Controller 的用户可见流程提示契约。它只描述 side-channel 进度事件，不参与 workflow 路由、gate 判断、task graph 调度或模型上下文注入。

## Files

- `src/progress/reporter.ts`：定义 `ProgressUpdate`、`ProgressStage`、`ProgressReporter` 和 noop reporter。
- `src/progress/node-progress.ts`：把 OpenCode child session 事件转换成节点进展记录，并读写 `nodes/<node-id>/progress.jsonl`。
- `src/tui/progress-panel.ts`：把 workflow state、节点进展和 live session status 整理成 TUI 面板 view-model。
- `src/tui.ts`：注册 `superpowers-progress` TUI route、`superpowers.progress` 命令入口，以及 session/sidebar 常驻进度 slot。

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

主会话常驻进度通过 TUI slot 展示：

- `session_prompt_right`：在 session prompt 右侧显示一行 compact progress。
- `sidebar_footer`：在 session sidebar footer 显示同一行 compact progress。

常驻行只显示 active workflow 中最新 running node 的 agent、task、durable/live status 和最新 progress 摘要。完整历史仍通过 `superpowers-progress` route 查看。
