# Bug Fix: TUI Realtime Workflow Progress

## 问题描述

- 日期: 2026-06-28
- 严重程度: High
- 影响范围: TUI `app_bottom`、`sidebar_content`、`prompt_progress`、`sidebar_footer` fallback 和 `superpowers-progress` route

用户反馈 workflow 进度没有及时展示。当前 TUI 能读取 workflow state 和 child progress，但展示链路仍存在延迟、选错 workflow、缺少状态边界提示的问题。

## 现有链路

当前进度展示由两类文件拼出来：

1. `runs/<run-id>/state.json`
   - workflow、phase、status、node_runs、pending_question、task_graph。
2. `runs/<run-id>/nodes/<node-id>/progress.jsonl`
   - child session 的 `session.status`、`message.part.updated`、tool/text/reasoning/patch 等事件。

TUI 入口：

- `src/tui.ts`
  - 注册 `sidebar_footer`、`sidebar_content`、`app_bottom`。
  - slot 内部每 1000ms 重新读取 state/progress 文件。
  - workflow 选择先匹配当前 session，再选 unfinished workflow，再按 `state.updated_at` 排序。
- `src/tui/progress-panel.ts`
  - 把 `WorkflowState + progress.jsonl + live session status` 合成 view model。
  - `sidebar_content` 显示 pending question、running nodes 或 latest node。
- `src/plugin.ts`
  - OpenCode event hook 把 child session 事件写入 `progress.jsonl`。

## 调查证据

### 1. 当前隔离 runtime 没有加载最新 dist

`dist/index.js` 和 `dist/tui.js` 是 2026-06-28 12:58 生成的，但隔离 server 日志最后启动时间是 2026-06-27 20:50 左右，端口 5096 上仍有旧 `opencode` 进程监听。

这说明如果用户观察的是 `127.0.0.1:5096` 对应的 Superagent runtime，当前进程没有重启，TUI 仍在使用旧插件代码。

### 2. state 时间和 progress 时间分离

当前 active run:

- run: `a7464814-bcc2-4fdd-b717-ced2a312de46`
- state updated: `2026-06-28T04:26:06.371Z`
- latest child progress: `2026-06-28T05:36:19.535Z`

child 进度持续写入 `progress.jsonl`，但不会更新 `state.updated_at`。TUI 的 global workflow 选择主要按 `state.updated_at` 排序，所以一个正在持续输出 progress 的 workflow 可能输给另一个 state 更新时间更晚、但没有真实 child 活动的 workflow。

### 3. unfinished workflow 状态集合滞后于 v4

`src/tui.ts` 的 `isUnfinishedWorkflow()` 目前只包含：

```ts
["intake", "running", "waiting_user", "blocked", "recovered_unknown"]
```

v4 新增或强化的状态没有纳入：

- `awaiting_design_approval`
- `awaiting_plan_approval`
- `waiting_user_decision`
- `failed`

这些状态都不是终态，TUI 应该优先展示并给出下一步，而不是被当成历史状态。

### 4. 展示内容缺少 workflow-level event timeline

当前 sidebar 主要显示 running session 或 latest node。它没有把这些 workflow 级事件作为第一等进度：

- `workflow_prepared`
- `design_approved`
- `plan_approved`
- `dispatch_failed`
- `late_report_ignored`
- `report_received`
- `workflow_canceled`

结果是用户能看到某个 child session 的 activity，但看不到完整 workflow 从 prepare、approval、dispatch、report 到 waiting/blocked/finish 的状态线。

### 5. 当前刷新策略是轮询文件，不是事件驱动

slot 通过 `setInterval` 每秒重读文件。这个策略能工作，但存在两个问题：

- 每个 slot 都独立扫描 workflow candidates 和 progress 文件，工作量随历史 run 增长。
- 轮询只能“下次刷新看到结果”，不能在关键事件发生时立即推送到 TUI。

## 根因判断

这不是单纯的 UI 文案问题，主要是数据模型和刷新模型的问题：

1. TUI 没有一个轻量、单文件、实时更新的 progress snapshot。
2. workflow 选择算法只看 `state.updated_at`，没有把 `progress.jsonl` 的最新时间纳入。
3. v4 非终态集合没有同步到 TUI。
4. workflow-level events 没有进入进度视图，用户只能看到 child session 片段。
5. 隔离 runtime 若不重启，会继续加载旧 dist，导致刚修完的 TUI 代码不可见。

## 推荐设计

### 目标

让用户在 TUI 中实时看到三层进展：

1. workflow 当前阶段：prepare/design/plan/approve/implement/check/finish。
2. node 当前活动：哪个 child session 正在运行、最近做了什么。
3. 下一步决策：等待批准、等待用户、正在运行、已阻塞、可重试、已完成。

用户当前关心的主展示面是：

- `app_bottom`
- `sidebar_content`
- `prompt_progress`

`sidebar_footer` 只作为 host 不展示主 surface 时的 fallback，不再作为主要设计目标。

### 设计方向

引入一个 runtime 维护的轻量 snapshot：

```text
.opencode/superpowers/
  progress-index.json
  runs/<run-id>/
    progress-snapshot.json
```

`progress-snapshot.json` 由 store/progress hook 在每次关键事件后原子写入：

```ts
type WorkflowProgressSnapshot = {
  run_id: string
  project: string
  workflow: string
  status: WorkflowStatus
  phase: string
  activation: "draft" | "active"
  updated_at: string
  latest_activity_at: string
  state_version?: string
  controller_feedback?: ControllerFeedback
  progress: {
    tasks_total?: number
    tasks_done?: number
    running_nodes: number
    stalled_nodes: number
    blocked_nodes: number
  }
  timeline: Array<{
    at: string
    scope: "workflow" | "node"
    kind: string
    node_id?: string
    session_id?: string
    agent?: string
    task_id?: string
    summary: string
    detail?: string
  }>
}
```

`progress-index.json` 只记录每个 project/run 的最新活动时间和 snapshot 路径：

```ts
type ProgressIndex = {
  current_run_id?: string
  runs: Array<{
    run_id: string
    status: WorkflowStatus
    latest_activity_at: string
    snapshot_path: string
  }>
}
```

### 写入规则

以下事件都应更新 snapshot：

- `prepareRun/startRun/activateRun`
- `approveDesign/approvePlan`
- `addNodeRun`
- `recordNodeResult`
- `consumePendingQuestion`
- `cancel`
- `markDispatchFailed`
- `recoverInterruptedRunningNodes`
- `nodeProgress.recordEvent`

关键点：child progress 写入时不需要改 `state.json`，但要更新 `progress-snapshot.json` 和 `progress-index.json` 的 `latest_activity_at`。这样 TUI 可以按真实活动时间选择 workflow。

### TUI 读取规则

TUI 不再每次扫描所有 run 的 `state.json + nodes/*/progress.jsonl`。优先读取：

1. `progress-index.json`
2. 当前 run 的 `progress-snapshot.json`
3. 如果 snapshot 缺失，再 fallback 到旧的 state/progress 扫描

workflow 选择优先级：

1. 如果 slot 有 session id，选拥有该 parent/child session 的 run。
2. 否则选 current run。
3. 否则选非终态 run，按 `latest_activity_at` 排序。
4. 终态 run 只作为没有任何非终态 run 时的 fallback。

非终态集合应包括：

```ts
[
  "intake",
  "running",
  "awaiting_design_approval",
  "awaiting_plan_approval",
  "waiting_user",
  "waiting_user_decision",
  "blocked",
  "failed",
  "recovered_unknown",
]
```

### 展示面分工

三类 surface 读取同一个 `WorkflowProgressSnapshot`，但渲染密度不同。不要让每个 slot 自己扫描 run/state/progress 并自行推理；slot 只做选择、降级和文本裁剪。

#### `app_bottom`: 常驻心跳

职责：

- 告诉用户当前有没有 workflow 在跑。
- 告诉用户 workflow 卡在哪个阶段。
- 告诉用户下一步是等待、批准、回答、重试、取消还是查看详情。

不承担：

- 不显示完整任务列表。
- 不显示长问题正文。
- 不显示 child session 的多行日志。
- 不承载交互控件。

推荐格式：

```text
SP <workflow> <status>@<phase> | <progress> | <now> | next: <action>
```

示例：

```text
SP feature running@implement | tasks 3/6, 1 running | T4 bun test 4s ago | next: wait
SP feature awaiting_design_approval | design ready | no child running | next: approve/revise
SP feature waiting_user | designer asks question | next: answer in main session
SP feature blocked@dispatch | planner dispatch failed | next: retry/cancel
SP feature finished@done | tasks 6/6 | checks passed | next: report
```

展示规则：

1. 一行内完成，按 host 宽度裁剪。
2. 优先展示 attention 状态，而不是最近普通 activity。
3. 如果没有 active workflow，默认不显示；只有诊断 route 或 debug 模式显示 `SP: no workflow state`。
4. 没有 `session_id` 时允许 global fallback，但必须按 `latest_activity_at` 选择 run，不能只按 `state.updated_at`。
5. 如果 snapshot stale，显示 `stale <duration>`，不要假装仍在实时更新。

#### `sidebar_content`: 主进度面板

职责：

- 承载 workflow 运行信息主视图。
- 展示阶段图、任务完成情况、运行中的 child session、最近 timeline。
- 在 waiting/approval/blocked/failed 场景下把原因和下一步放到顶部。

不承担：

- 不收集用户输入。
- 不替换 controller 在主会话中的提问。
- 不展示无限日志，只展示最近摘要。

推荐结构：

```text
Superpowers
feature · running · implement
Next: wait_running_node

Attention
none

Progress
Design ✓  Plan ✓  Tasks 3/6  Running 1  Blocked 0

Running
- sp-implementer T4 · running · 4s ago
  tool: bun test test/controller-intake.test.ts
- sp-verifier T3 · stalled · 42s
  last: waiting for child session status

Recent
12:03:11 workflow plan_approved
12:03:15 node_running sp-implementer T4
12:03:31 tool_running bun test
```

attention 场景要顶置：

```text
Superpowers
feature · awaiting_plan_approval · plan

Attention
Plan ready. Controller should ask user to approve or request revision.

Next
approve_plan / revise_plan / cancel

Recent
12:03:11 planner completed plan
12:03:12 workflow awaiting_plan_approval
```

`waiting_user` 场景：

```text
Attention
sp-designer needs user input
Question: <one or two line truncated question>
Options:
1. <option>
2. <option>
3. <option>

Next
answer in main session; controller will call sp_start(run_id, resume_input)
```

展示规则：

1. `sidebar_content` 是唯一的多行 workflow resident surface。
2. 如果 slot 带 `session_id`，优先绑定 parent session 或 child session 所属 run。
3. 如果没有 `session_id`，可以展示当前 project 的 current/active run，但文案要避免误导成当前会话绑定。
4. 只展示最近 5-8 条 timeline；完整历史在 `superpowers-progress` route。
5. 对 `dispatch_failed`、`late_report_ignored`、`waiting_user_decision`、`failed`、`recovered_unknown` 必须有显式文案，不能落到普通 running 分支。

#### `prompt_progress`: 当前输入上下文进度条

`prompt_progress` 不是之前被移除的 `session_prompt_right`。它只在 host 明确提供专用 progress slot 时注册，用于靠近输入区显示当前上下文的极简状态。它不能变成第二个 sidebar，也不能挤占输入框。

职责：

- 用户正在输入时，给出当前 workflow 的一眼状态。
- 提醒用户当前是否需要批准、回答或等待。
- 帮助用户判断这次输入会不会影响当前 workflow。

不承担：

- 不显示长文本。
- 不显示完整问题和选项。
- 不做 global 噪声广播。
- 不作为唯一进度入口。

推荐格式：

```text
SP: <status> · <phase/task> · <short activity> · next <action>
```

示例：

```text
SP: running · T4 implement · bun test 4s · next wait
SP: approval · design ready · next approve/revise
SP: question · designer waiting · next answer
SP: blocked · dispatch failed · next retry/cancel
SP: finished · checks passed · next report
```

展示规则：

1. 最多一行；host 允许两行时也只用于换行裁剪，不增加信息层级。
2. 默认只在当前 session 属于 workflow parent/child 时展示。
3. 如果 host 的 `prompt_progress` 是 global slot，必须显示当前 active run，但要避免与无关会话强绑定。
4. 当有 pending approval 或 pending question 时，`prompt_progress` 只提示 `approval/question`，详细内容交给 `sidebar_content` 和主会话。
5. 如果 host 不支持 `prompt_progress` 这个精确 slot，第一版实现不自动回退到 `session_prompt_right`；是否启用 prompt-adjacent fallback 需要单独确认。

### 信息优先级

所有 surface 使用同一套 attention priority：

1. `waiting_user`: 用户回答会解除阻塞。
2. `awaiting_design_approval` / `awaiting_plan_approval`: 用户批准或要求修改会推进 workflow。
3. `dispatch_failed` / `waiting_user_decision` / `blocked` / `failed` / `recovered_unknown`: 需要 controller 决策或用户介入。
4. `running` 且有 stalled child: 仍在 workflow 中，但用户需要看到 child 已经长时间无进展。
5. `running` 且有 active child: 展示最近 child activity。
6. `finished` / `canceled`: 短暂展示终态，然后只在 route 或历史 fallback 中出现。

### 渲染数据契约

`WorkflowProgressSnapshot` 增加专门给 TUI 的派生字段，避免三个 surface 重复推理：

```ts
type WorkflowProgressSnapshot = {
  run_id: string
  workflow: string
  status: WorkflowStatus
  phase: string
  latest_activity_at: string
  attention?: {
    kind:
      | "approval"
      | "question"
      | "blocked"
      | "failed"
      | "stalled"
      | "none"
    title: string
    summary: string
    next_action: string
    severity: "info" | "warning" | "error"
  }
  rollup: {
    tasks_total?: number
    tasks_done?: number
    running_nodes: number
    stalled_nodes: number
    blocked_nodes: number
  }
  current_activity?: {
    node_id?: string
    agent?: string
    task_id?: string
    kind: string
    summary: string
    age_ms: number
  }
  timeline: Array<{
    at: string
    scope: "workflow" | "node"
    kind: string
    summary: string
    node_id?: string
    agent?: string
    task_id?: string
  }>
}
```

各 surface 只消费这些字段：

- `app_bottom`: `workflow/status/phase + attention/current_activity + rollup + next_action`
- `sidebar_content`: 全量消费 `attention/rollup/current_activity/timeline`
- `prompt_progress`: `attention/current_activity/next_action` 的极简版本

### 与现有约束的关系

之前把 `session_prompt_right` 移除，是因为它位于输入区附近、空间不可控、容易挤占输入体验。`prompt_progress` 的设计边界不同：

- 它必须是 host 明确提供的 progress slot。
- 它只显示极简状态，不显示 workflow 详情。
- 它不能替代 `sidebar_content`。
- 它不承担用户输入和审批交互。

因此，`prompt_progress` 可以加入 vNext 设计，但实现时要先确认 host 是否真的暴露该 slot。确认前，当前实现仍以 `app_bottom + sidebar_content + sidebar_footer fallback` 为准。

### 主会话工具结果补充通道

主会话区域中灰色工具调用结果可以用于展示 child progress 的按需摘要，但不能作为实时进度主通道。

设计约束：

1. 不新增 public workflow tool，继续使用 `sp_status`。
2. controller 在用户询问进展时调用 `sp_status(include_progress=true)`。
3. 工具返回 `progress_digest`，包含 `current_activity`、`recent_activity`、`attention` 和 `recommended_next`。
4. `progress_digest.delivery = "on_demand_tool_result"`，明确它只代表一次查询结果，不是实时流。
5. 普通 child progress 不通过 `session.prompt` 注入主会话，避免触发额外模型回合或污染 controller 上下文。

适合进入主会话的只有用户主动查询、等待批准、等待用户输入、阻塞、失败、长时间 stalled 等低频关键信息。实时刷新仍由 `app_bottom`、`sidebar_content` 和可用时的 `prompt_progress` 承担。

## 最小修复切片

### P0: 当前问题止血

1. `isUnfinishedWorkflow()` 加入 v4 非终态。
2. workflow 排序使用 `max(state.updated_at, latest progress at)`。
3. current run 优先级高于历史 run，除非 slot 明确匹配其他 session。
4. `app_bottom` 和 `sidebar_content` 改用同一套 attention priority，先解决等待批准、等待用户、阻塞、失败状态不可见的问题。
5. 检查 host 是否支持 `prompt_progress` slot；如果不支持，只记录为 pending capability，不回退到 `session_prompt_right`。
6. 部署流程中明确重启 `superagent`，确保最新 `dist/tui.js` 生效。

### P1: 轻量实时 snapshot

1. 新增 `src/progress/workflow-snapshot.ts`。
2. store 状态变更后写 `progress-snapshot.json`。
3. node progress event 后更新 snapshot/index。
4. TUI 优先读 snapshot/index。
5. 三个 surface 共用 snapshot 派生字段：`attention`、`rollup`、`current_activity`、`timeline`。
6. 如果 host 支持 `prompt_progress`，注册专用 renderer；如果不支持，测试应证明不会误注册旧 prompt/right slot。

### P2: 更好的用户体验

1. `sidebar_content` 展示 `controller_feedback.recommended_next` 和 attention 下一步。
2. timeline 合并 workflow events 和 node progress。
3. stalled、blocked、waiting approval、waiting user 用不同前缀展示。
4. `prompt_progress` 增加宽度裁剪和 session/global 绑定测试。
5. route 页面增加 “why no progress” diagnostic，例如未部署、无 current run、无 matching session、snapshot stale。

## 验证计划

- 单元测试：
  - v4 非终态 run 可被 global slot 选中。
  - child progress 时间晚于 state 更新时间时，slot 选择 child progress 最新的 run。
  - current run 优先于历史终态 run。
  - snapshot 缺失时 fallback 到旧 state/progress 扫描。
  - dispatch_failed/waiting_user_decision/awaiting_plan_approval 都有可读 `app_bottom` 和 `sidebar_content` 文案。
  - `prompt_progress` 只在 host 支持该 slot 时注册；不自动注册 `session_prompt_right` fallback。
  - `prompt_progress` 在无关 session 下隐藏或显示明确 global active run，不误称为当前会话进度。
- 集成测试：
  - 创建 run -> addNodeRun -> append progress，slot 在 1s 内展示新 progress。
  - append progress 不改 state.updated_at，也能更新 `latest_activity_at` 并刷新 TUI。
  - waiting approval、waiting user、dispatch failed 三类状态能同时刷新到 `app_bottom` 和 `sidebar_content`。
  - 重启 superagent 后 TUI 加载最新 dist，进度 route 能看到最新 snapshot。
- 手工验证：
  - `bun run build`
  - `bun run test`
  - `bun run deploy:superagent`
  - 打开 `http://127.0.0.1:5096`，确认 `app_bottom` 和 `sidebar_content` 能实时显示 workflow progress。
  - 如果当前 host 版本支持 `prompt_progress`，确认输入区附近只显示一行极简状态，且不会挤占输入框。

## 建议

先实施 P0 + P1。P0 能快速解决“选错/漏选 workflow”和“旧 runtime 未生效”的问题；P1 才能把实时展示从“每个 slot 扫文件拼结果”改成“runtime 维护一个可直接渲染的事实快照”。

`prompt_progress` 的实现取决于 host slot 能力。如果 host 已暴露该 slot，可以纳入 P1；如果没有，先完成 `app_bottom + sidebar_content` 的实时链路，不用旧 prompt/right slot 硬凑。
