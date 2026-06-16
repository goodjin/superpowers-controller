# Progress Module

## Responsibility

progress 模块定义 Superpowers Controller 的用户可见流程提示契约。它只描述 side-channel 进度事件，不参与 workflow 路由、gate 判断、task graph 调度或模型上下文注入。

## Files

- `src/progress/reporter.ts`：定义 `ProgressUpdate`、`ProgressStage`、`ProgressReporter` 和 noop reporter。

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
