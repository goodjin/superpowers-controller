# Bug Fix: sp_report Controller Decision Notification

## 问题描述

- 日期: 2026-07-09
- 严重程度: High
- 影响范围: `sp_report` 后的 controller decision 可见性

最新 workflow `3747005f-a02a-45d0-ad44-723f7b814cd9` 中，`sp-planner` 已成功调用 `sp_report(event="plan", status="passed")`，节点状态变为 `passed`，并写入 `pending_workflow_expansion`。但 workflow 因 `auto_expansion=false` 进入 `waiting_controller_decision` 后，parent `superpowers-agent` 没有自动收到下一步裁决 prompt，用户看到的是 `sp_report` 像卡住了。

## 根因分析

- `sp_report` 工具本身已完成，tool part 状态为 `completed`。
- `recordNodeResult()` 正确将 workflow 置为 `waiting_controller_decision`，并在工具返回的 `controller_feedback.allowed_controller_decisions` 中给出 `apply_workflow_patch` payload。
- `createReportHandler()` 只对 `needs_user` 调用 `orchestrator.notifyParent()`；对 `waiting_controller_decision` 只返回 tool output，不主动通知 parent。
- 如果 parent session 没有继续读到或执行这段 tool output，workflow 会停在 controller decision，表现为静默卡住。

## 修复方案

- `sp_report` 后检查最新 state。
- 如果 state 是 `waiting_controller_decision`，向 `parent_session_id` 投递 controller decision prompt。
- prompt 要求 controller 先调用 `sp_status` 对齐 runtime fact，再从 `allowed_controller_decisions` 中选择安全动作并调用 `sp_start(start_action="resolve_controller_decision")`。
- 不自动应用 `apply_workflow_patch`，保留主控裁决边界和用户确认语义。

## 验收标准

- auto expansion disabled 且 plan report 带 workflow/task graph expansion 时，`sp_report` 完成后通知 parent。
- 通知目标是 `parent_session_id` + `superpowers-agent`。
- prompt 包含 `waiting_controller_decision`、`sp_status`、`sp_start`、`resolve_controller_decision` 和 `apply_workflow_patch`。
- 现有 `needs_user`、design/plan foreground approval、普通 dispatch 行为不回退。
