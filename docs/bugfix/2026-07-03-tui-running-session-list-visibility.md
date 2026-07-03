# Bug Fix: TUI Running Session List Visibility

## 问题描述

- 日期: 2026-07-03
- 严重程度: High
- 影响范围: Super-Agent 主会话 TUI 常驻进度、右侧栏 workflow 运行列表

用户反馈：

1. 主会话底部没有清楚展示当前正在运行的子会话数量。
2. 右侧 `sidebar_content` 没有展示插件将要运行的会话和正在运行的会话列表。
3. 展示方式可以参考 OpenCode 原生 TodoWrite：用户需要一眼看到待执行项、运行中项和当前进展。

## 已确认事实

- 当前 TUI slot 注册在 `src/tui.ts`：
  - `app_bottom` 使用 `workflow-status` renderer。
  - `sidebar_content` 使用 `sidebar` renderer。
  - `sidebar_footer` 使用 `workflow-status` renderer。
- 当前 `renderWorkflowStatusText()` 已包含 `sessions <n> running`，但这只是英文摘要的一部分；当用户扫视主会话底部时，不够稳定突出，也没有单独强调“当前运行子会话数”。
- 当前 `renderSidebarProgressText()` 只在有 running `node_runs` 时展示 `running` 列表；没有把 `task_graph.tasks` 中尚未 dispatch 的待运行任务列出来。
- `ProgressPanelTaskRow` 已经能从 `task_graph.tasks` 和 `node_runs` 推导 `pending/running/passed/...`，可以复用它做 TodoWrite 风格列表，不需要新增状态源。
- 本地 `tools/opencode-1.16.2` 只有可执行包，没有可读 TUI 源码；TodoWrite 内部渲染不能直接对照源码。这里按用户看到的 TodoWrite 信息结构学习：分状态、列任务、突出当前项。

## 根因分析

### 1. 底部摘要不够明确

问题位置：

- `src/tui/progress-panel.ts`

原因：

`app_bottom` 输出当前是：

```text
SP: feature running@implement | tasks 0/1 done | sessions 1 running | ...
```

这条文本包含运行数，但它不是稳定的首要字段，也没有区分 running/stalled/waiting permission 的总 active child session 数。用户看到底部时，仍可能认为没有“当前在运行的子会话数量信息”。

### 2. 右侧栏缺少 planned/pending 列表

问题位置：

- `src/tui/progress-panel.ts`
- `test/tui-plugin.test.ts`

原因：

`sidebar_content` 只从 `model.rows` 里筛选 `durable_status === "running"`。这能显示已经创建的 child session，但不能显示插件接下来准备运行的任务。对于有 `task_graph` 的 workflow，待运行项已经在 state 里存在，但没有渲染出来。

### 3. 测试只覆盖 running row，不覆盖计划队列

现有测试断言了 running session 能出现在 sidebar，但没有断言：

- `app_bottom` 明确显示 active/running child session count。
- `sidebar_content` 同时展示 pending/planned 和 running。
- 多任务图中 pending、running、passed 的排序和截断。

## 修复方案

1. 调整底部状态文案。
   - 在 `renderWorkflowStatusText()` 中把 child session 计数做成稳定字段，例如 `children 1 active (1 running)`。
   - active count 覆盖 running、stalled、waiting permission，避免卡住或等权限时被误读为没有子会话。
   - 保留现有 workflow/status/phase、task 完成数和 latest activity。

2. 把 `sidebar_content` 改成 TodoWrite 风格的任务列表。
   - 顶部仍显示 workflow 摘要。
   - 增加 `child sessions` 区块，优先列运行中 child session。
   - 增加 `planned sessions` 或 `next sessions` 区块，从 `model.tasks` 中列出 pending/running/blocked 等未完成任务。
   - 对每一行展示状态、task id/title、agent，以及已有 node session 的 latest summary。
   - 对没有 `task_graph` 的旧 workflow，继续使用现有 running/latest node fallback。

3. 更新测试。
   - 新增多任务 workflow fixture：T1 running，T2 pending，T3 pending with dependency。
   - 断言 `app_bottom` 包含明确 child count。
   - 断言 `sidebar_content` 同时包含 running child session 和 pending planned sessions。
   - 保留 waiting permission、global fallback、session-bound fallback 的既有回归。

4. 更新模块文档。
   - 更新 `docs/modules/progress.md` 的 TUI Surfaces，说明 bottom 负责 child count，sidebar 负责 planned/running session list。
   - 根据实际实现补充本 bugfix 文档的实际修复和验证结果。

## 验收标准

- 主会话底部能稳定看到当前 active/running child session 数量。
- `sidebar_content` 能看到当前 running child sessions。
- `sidebar_content` 能看到插件接下来将运行的 pending/planned task/session 列表。
- waiting permission/stalled 状态仍然可见，不被普通 running 覆盖。
- 不恢复 `session_prompt_right`、`home_prompt` 或 `home_prompt_right`。
- 编译、测试、打包通过后提交并推送。

## 计划验证命令

```bash
bun test test/tui-plugin.test.ts test/progress-panel.test.ts
bun run test
bun run build
npm pack --dry-run
```

## 实际修复

- `src/tui/progress-panel.ts`
  - `renderWorkflowStatusText()` 改为稳定输出 `children <n> active (...)`，明确展示 active child session 数量。
  - `children` 括号内继续区分 `running`、`stalled` 和 `waiting permission`。
  - `renderSidebarProgressText()` 改为先展示 `child sessions`，再展示 `planned sessions`。
  - `planned sessions` 从 `task_graph.tasks` 和 `node_runs` 推导，不新增状态源。
  - `ProgressPanelTaskRow` 增加 `agent`，让 planned row 可以展示即将由哪个 agent/session 执行。
- `test/progress-panel.test.ts`
  - 更新底部状态和 sidebar 文本断言。
  - 增加 TodoWrite 风格 planned/running task list 的纯渲染回归测试。
- `test/tui-plugin.test.ts`
  - 更新 TUI slot 断言，覆盖 `children 1 active (1 running)`。
  - 增加 `sidebar_content` 同时展示 running child session 和 planned pending sessions 的 slot 级回归测试。
- `docs/modules/progress.md`
  - 更新 `app_bottom` 和 `sidebar_content` 的展示语义。
  - 记录 planned/running 列表的数据来源和状态范围。

## 实际验证结果

- ✅ `bun test test/progress-panel.test.ts test/tui-plugin.test.ts`
- ✅ `bun run test`
- ✅ `bun run build`
- ✅ `npm pack --dry-run`
