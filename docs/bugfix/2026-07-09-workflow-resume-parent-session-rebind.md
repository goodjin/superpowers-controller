# Bug Fix: Workflow resume keeps old parent session

## 问题描述

- 日期: 2026-07-09
- 严重程度: High
- 影响范围: workflow resume, controller decision, TUI session routing

用户从新的 controller 会话续跑旧 workflow 时，workflow state 仍保留旧的 `parent_session_id`。后续 TUI surface、parent-led dispatch 和 session selection 会继续把 workflow 归属到旧会话，造成“当前会话切回旧会话”的体验。

## 根因分析

- 问题位置: `src/tools/sp-start.ts`
- `sp_start` 入口将 `parentSessionID` 计算为 `current.parent_session_id ?? callerSessionID`。
- 只要 workflow 已存在，就优先沿用旧 parent；新 controller 会话调用 `sp_start(run_id, ...)` 不会接管 parent。
- child session 调用恢复/审批时又不能盲目改 parent，否则 foreground child 会把 parent 错绑成 child。

## 修复方案

1. `sp_start` 根据调用会话判断 parent:
   - 如果调用 session 是当前 workflow 的 child node session，保留旧 `parent_session_id`。
   - 如果调用 session 不是 child session，则认为它是新的 controller session，并把 parent rebinding 到当前 session。
2. state 更新时保留 `parent_session_rebound` 历史记录，记录 old -> new。
3. 补充测试覆盖:
   - 新 controller 会话续跑 interrupted workflow 时会重绑 parent，并让新 child dispatch 归属新 parent。
   - child session 调用时不抢占 parent。

## 验证步骤

1. `bun test test/controller-intake.test.ts`
2. `bun run build`
3. `bun run test`

## 边界

- 只在 controller-side `sp_start` 续跑/决策路径重绑 parent。
- `sp_report` 仍按 child `session_id` 匹配 node，不改变 parent。
