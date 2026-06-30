# Bug Fix: TUI Slot Status And sp_status Detail

## Problem

日期: 2026-06-26
严重程度: Medium
影响范围: Superagent TUI resident surfaces, `sp_status` diagnostic quality

用户反馈两个 UI 现象：

- 底部会话状态仍然没有及时更新到最新 workflow/session 状态。
- 右侧 `sidebar_content` 仍然没有展示 workflow 会话信息。

同时需要重新设计 `sp_status`，让主控能查询更详细、更实时的会话状态，而不是只拿 durable `state.json`。

## Evidence

当前隔离 runtime 配置：

- server plugin: `/Users/jin/github/superpowers-controller/dist/index.js`
- TUI plugin: `/Users/jin/github/superpowers-controller/dist/tui.js`
- workflow project: `/Users/jin/.local/share/superpowers-controller-test/project`

当前 durable workflow 已经是最新状态：

- current run: `b99af90a-6cad-4a07-93a7-21ae8b79e472`
- workflow status: `running`
- current phase: `implement`
- latest node: `012-implement-T3-retry-2`
- latest node status: `running`
- latest node session: `ses_0fb8f281bffetWj2gks9g3GEpB`

当前 progress 文件也已经有实时事件：

- `nodes/012-implement-T3-retry-2/progress.jsonl`
- 最新记录包含 `bash running`
- 文件已更新到 2026-06-26 23:02 本地时间附近

所以问题不在 state/progress 没写入，而在 TUI resident surface 的 slot 调用/重渲染/绑定链路，或者 `sp_status` 只读 durable state 导致主控看不到 live/progress。

## Root Cause Analysis

### 1. TUI slot 参数形态有适配风险

OpenTUI core 类型定义的 slot renderer 是：

```ts
type SlotRenderer<TNode, TProps, TContext> = (ctx: Readonly<TContext>, props: TProps) => TNode
```

OpenCode 1.16.2 的 `TuiHostSlotMap` 确认：

```ts
sidebar_content: { session_id: string }
sidebar_footer: { session_id: string }
```

当前代码写成：

```ts
(_context, props) => { ... slotSessionID(props) ... }
```

这在类型层面看起来成立，但实际 host/runtime 如果在某些路径只把 merged props 作为第一个参数调用，当前实现会把第一个参数当 `_context` 丢弃，导致 `session_id` 永远读不到。结果是：

- `sidebar_content/sidebar_footer` 不能按当前 session 绑定 workflow。
- `progressModel()` 可能因为 session 不匹配而返回 inactive model。
- 用户看到右侧栏没有 workflow 会话信息。

即使当前 OpenTUI 类型是双参数，也需要增加兼容提取，避免 host 版本差异导致 silent empty。

### 2. `sidebar_content` 缺少可见诊断

当前 `sidebar_content` 如果没有 active model 就返回空字符串/`null`。这会让三种情况看起来一样：

- slot 没被 host 调用。
- slot 被调用但没拿到 `session_id`。
- slot 被调用并拿到 session，但 resolver 没找到 workflow。

需要在开发/诊断路径让 route 或测试可以区分这些状态。生产 UI 不应噪声过大，但至少 global fallback 和 route 应给出来源诊断。

### 3. 底部状态依赖 polling，但没有对 slot 参数和选中候选做可测证明

源码已经每秒重读 progress/state：

```ts
setInterval(() => setText(safeProgressSlotText(...)), refreshMs)
```

但测试主要验证同步 `refreshMs: 0` 场景，没有覆盖“同一 slot 实例创建后，state/progress 变化，下一次 tick 展示最新 node”的行为。

需要补一个 fake timer 或可控 refresh 测试，确认 resident slot 不是只在创建时读一次。

### 4. `sp_status` 当前只返回 durable state

当前 `sp_status` 返回：

- `current`
- `task`
- `incomplete_workflows`
- `source`

它不读：

- `nodes/<node-id>/progress.jsonl`
- OpenCode live session status
- 当前 tool context 的 session id 和匹配关系
- latest running/interrupted/stalled node 摘要

因此主控无法用 `sp_status` 做“现在到底哪个 child session 在跑、最近有没有活动、最后一次错误是什么、是否只是 durable running 但 live idle”的判断。

## Fix Plan

### 1. Harden TUI slot argument extraction

修改 `src/tui.ts`：

- 将 resident slot renderer 保持双参数签名，但同时从 `_context` 和 `props` 提取 slot props。
- 新增 `slotSessionIDFromArgs(context, props)`：
  - 优先读 `props.session_id`
  - 兼容 `props.sessionID`
  - 兼容 `context.session_id`
  - 兼容 `context.sessionID`
  - 兼容 `context.session.id`
- `safeProgressSlotText()` 中判断是否有 session props 时，使用统一提取结果，不再重复调用只读 `props` 的 `slotSessionID()`。

### 2. Add TUI diagnostics without polluting normal UI

修改 `src/tui.ts` / `src/tui/progress-panel.ts`：

- `superpowers-progress` route 继续展示 fallback project diagnostic。
- 对 session slot，如果传入 session 但找不到绑定 workflow，返回空；如果没有传入 session 且 renderer 是 sidebar，允许 global fallback 展示最近 active workflow，避免右栏完全空白。
- 在测试 helper 中暴露/覆盖 slot props 兼容逻辑，不把调试文本强塞进生产 sidebar。

### 3. Verify resident refresh behavior

新增/调整 `test/tui-plugin.test.ts`：

- `sidebar_content` 支持 OpenTUI 双参数调用：`slot(context, { session_id })`。
- `sidebar_content` 支持 merged-props 单参数调用：`slot({ session_id })`。
- `sidebar_content` 支持 nested session context：`slot({ session: { id } })`。
- 同一 slot 创建后，追加新的 progress 或新增 running node，下一次 refresh tick 展示最新状态。
- 当前 run 同时存在 `interrupted` old node 和 `running` retry node 时，底部和 sidebar 优先展示 retry node。

### 4. Extend `sp_status` detail/realtime model

修改 `src/tools/sp-status.ts`，建议参数：

```ts
workflow_id?: string
task_id?: string
session_id?: string
include_history?: boolean
detail?: "summary" | "task" | "sessions" | "full"
include_progress?: boolean
progress_tail?: number
```

默认保持兼容：

- 不传参数仍返回当前 workflow summary。
- `task_id` 仍返回 focused task。
- `include_history` 仍返回 incomplete workflows。

新增输出分层：

- `durable`: 当前 workflow state 的摘要和原始 state。
- `tasks`: task graph task 与 latest node/check chain 状态。
- `sessions`: 每个 node session 的 durable status、started/ended/reported 时间、latest progress、activity age、stalled 标记。
- `live`: 从可用 runtime API 读取的 live session status；如果 tool context 不能直接拿 host session API，则明确返回 `source: "unavailable_in_tool_context"`，不伪造实时状态。
- `recommended_next`: 只读建议，例如 `wait_running_node`、`retry_interrupted_task`、`answer_pending_question`、`cancel_or_restart_stale_node`，但不改变 state。

### 5. Share status assembly code

避免 TUI 和 `sp_status` 各自拼一套状态：

- 抽出 `src/status/workflow-status.ts` 或复用/扩展 `src/tui/progress-panel.ts` 的 view-model builder。
- 输入：`WorkflowState`、`NodeProgressEntry[]`、可选 live status provider、now。
- 输出：可渲染 summary + JSON detail。

这样 TUI 和 `sp_status` 对 running/stalled/interrupted/latest progress 的判断一致。

## Tests

新增/调整：

- `test/tui-plugin.test.ts`
  - slot 参数兼容。
  - resident refresh 更新。
  - interrupted old node + running retry node 的展示优先级。
- `test/progress-panel.test.ts`
  - `interrupted` 和 retry node 的 row/task summary。
  - stalled/latest progress age。
- `test/tools.test.ts`
  - `sp_status(detail="sessions", include_progress=true)` 返回 session detail。
  - `sp_status(task_id="T3", detail="full")` 聚焦 task 并包含全部 attempts。
  - live status 不可用时明确标注 unavailable，不误报。

## Validation

执行：

```bash
bun test test/tui-plugin.test.ts test/progress-panel.test.ts test/tools.test.ts
bun run build
bun run test
bun run test:e2e:opencode
bun run deploy:superagent
```

部署后用当前隔离 run 验证：

- `app_bottom` 显示 `feature running@implement`，running node 指向 `012-implement-T3-retry-2` 或 T3 retry session。
- `sidebar_content` 在 parent session 和 child session 页面都展示 workflow summary + running node。
- `sp_status(detail="sessions", include_progress=true, progress_tail=5)` 能看到 `012-implement-T3-retry-2` 的 latest progress。

## Acceptance Criteria

- 右侧 `sidebar_content` 不再因为 slot 参数形态差异而空白。
- 底部 resident slot 能在 state/progress 文件变化后刷新到最新 node。
- `sp_status` 能查询 task/session 级 detail，且清楚区分 durable state、progress file、live runtime status。
- 无法获得 live runtime status 时输出明确来源，不把 durable `running` 当作 live busy。

## Implementation Notes

实际实现按上述方向落地：

- `ProjectStore` 增加进程内 runtime cache。启动时从 durable snapshot 加载，后续 `readCurrent()`、`readRun()` 和 `listRuns()` 读 runtime memory；状态变更先更新 memory，再同步写 durable 文件。
- TUI resident slot 同时兼容 `(ctx, props)` 和 merged-props 调用形态，从 `props.session_id`、`props.sessionID`、`ctx.session_id`、`ctx.sessionID`、`ctx.session.id` 提取 session。
- `sp_status` 新增 `detail`、`session_id`、`include_progress` 和 `progress_tail` 参数，输出分为 `runtime`、`durable`、`summary`、`sessions`、`task` 和 `recommended_next`。
- `sp_status` 在工具上下文无法读取 OpenCode live session API 时，明确输出 `live.source = "unavailable_in_tool_context"`。
- 新增 `src/status/workflow-status.ts` 统一组装 status detail，避免 `sp_status` 和 TUI 对 latest progress / stalled / interrupted 的判断分叉。

## Follow-up: Startup Running Workflow Residue

日期: 2026-06-27

现场复查发现两个叠加原因：

- Restarting the `superagent` TUI does not necessarily restart the background `opencode serve` process on port 5096. The listener must be checked separately with the deploy script or `lsof`.
- The durable current run can have workflow-level `status: "running"` even when every `node_runs[]` entry is already terminal. Earlier startup recovery only converted `node_runs[].status === "running"` to `interrupted`, so a fresh TUI/store could still display the workflow as running after restart.

Fix:

- Plugin startup creates the project store with startup reconciliation enabled before exposing runtime memory.
- TUI slot reads stay side-effect-free; they consume the reconciled durable snapshot written by plugin startup instead of interrupting active nodes during UI reads.
- Reconciliation converts both persisted running child nodes and persisted active workflow-level `status === "running"` into `recovered_unknown`; draft prepared workflows remain unchanged because they still wait for explicit `sp_start`.
- `sp_status` now recommends `resume_or_cancel_recovered_workflow` when startup recovery found only workflow-level running state without a blocking interrupted latest attempt.

Additional verification:

- `test/store.test.ts` covers fresh store loading of a workflow-level running snapshot with no running nodes.
- `test/tools.test.ts` covers `sp_status` reporting `sessions.running = 0` and `summary.status = "recovered_unknown"` for that startup-recovered state.
