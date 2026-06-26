# Bug Fix: TUI Current Workflow Surface

## Problem

用户反馈两个现象：

- `app_bottom` 底部会话状态一直不刷新，显示的是旧 workflow，而不是当前正在运行的 workflow。
- `sidebar_content` 右侧栏一直没有展示 workflow 运行信息，看起来仍然是主会话摘要。

这两个现象都发生在 TUI resident surface，不影响 `sp_status` / `sp_start` / `sp_report` 的 durable workflow 状态。

## Current Flow

TUI 插件注册三个 resident slot：

- `app_bottom`：全局 slot，没有 `session_id` props，当前实现允许全局读取 workflow。
- `sidebar_content`：session slot，host 类型定义要求传入 `session_id`。
- `sidebar_footer`：session slot，host 类型定义要求传入 `session_id`。

当前 resolver 逻辑：

1. 先读 `api.state.path.directory/.opencode/superpowers/current.json`。
2. 如果没有，再按固定顺序尝试 `SUPERAGENT_PROJECT_DIR`、`OPENCODE_SUPERPOWERS_PROJECT_DIR`、`SUPERAGENT_ROOT/project`、隔离 runtime 的相邻 `project`。
3. 找到第一个 `current.json` 就返回。

## Root Cause

底部旧状态的直接原因是 resolver 只按固定 project 顺序选择 `current.json`。当 TUI host 的 `api.state.path.directory` 不是当前 workflow project，或者配置目录里留下旧 run 的 `current.json` 时，`app_bottom` 没有 session id 可校验，会稳定显示第一个 fallback workflow。

`sidebar_content` 的问题需要分两层看：

- 插件已经注册了 `sidebar_content`，且 SDK 类型确认它是 session slot，会收到 `session_id`。
- 当前 resolver 没有利用 `session_id` 选择 workflow。即使 sidebar slot 在当前会话页被调用，也可能先拿到旧 workflow；随后 `progressModel()` 发现当前 `session_id` 不属于旧 workflow，就返回 inactive model，最终渲染为空。用户看到的就是右侧栏仍然只有 host 原生摘要。

这不是靠新增更多 slot 能解决的问题。需要把 workflow 选择规则改成“当前 session 优先，其次 current project，其次最近活跃 fallback”。

## Fix Plan

### 1. 让 TUI resolver 接收 slot session

把 `currentWorkflowContext(api)` 改为 `currentWorkflowContext(api, sessionID?)`，route 场景没有 session id，resident slot 传入 `slotSessionID(props)`。

### 2. 增加 workflow 候选排序

对每个候选 project 不只读 `current.json`，还读取该 project 的 `listRuns()`：

1. 如果有 `sessionID`，优先返回包含该 session 的 run，包括 `parent_session_id` 或任一 `node_runs[].session_id`。
2. 如果 host 当前目录有 current workflow，且没有更高优先级的 session 匹配，返回 host 当前目录 current workflow。
3. fallback project 中优先返回未结束且 `updated_at` 最新的 run；未结束状态包括 `intake`、`running`、`waiting_user`、`blocked`、`recovered_unknown`。
4. 如果没有未结束 run，再返回 `updated_at` 最新的 fallback current/list run，避免显示更旧的 `current.json`。

这样：

- `sidebar_content/sidebar_footer` 能按当前 session 绑定到正确 workflow。
- `app_bottom` 没有 session id 时，也会在 fallback 间选最近活跃 workflow，而不是第一个 env 目录。

### 3. 明确 sidebar 不接管 host 原生摘要

`sidebar_content` 是 host sidebar 的 plugin slot，不是替换整个右侧栏。插件只能在 host 暴露的 slot 位置渲染 workflow 信息；如果 host 同时显示主会话摘要，两者可能共存。修复目标是让 slot 有内容且内容来自当前 workflow，不声称替换 host 原生摘要。

### 4. 更新文档

更新 `docs/modules/progress.md`：

- 区分 global slot 和 session slot。
- 说明 resolver 的 session 优先规则。
- 删除“只要无 props 就显示 current workflow”这种容易误导的表述，改成 `app_bottom` global fallback 和 session slot session-bound fallback。

## Tests

新增/调整 `test/tui-plugin.test.ts`：

- 两个 fallback project 都有 workflow 时，`app_bottom` 选择 `updated_at` 最新的 active workflow，而不是固定 env 顺序里的旧 workflow。
- `sidebar_content` 传入当前 session id 时，即使旧 fallback project 排在前面，也选择包含该 session 的 workflow。
- 无关 session 仍然隐藏，不把 workflow 信息泄露到不相关 session。
- `superpowers-progress` route 继续能读取当前/fallback workflow。

## Validation

执行：

```bash
bun test test/tui-plugin.test.ts test/progress-panel.test.ts
bun run test
bun run build
bun run test:e2e:opencode
```

通过后按项目流程提交并推送。
