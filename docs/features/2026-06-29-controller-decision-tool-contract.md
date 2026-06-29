# Feature: Controller Decision Tool Contract

## Context

v5 设计要求插件逻辑保持灵活：当 workflow 按预期运行时由 runtime 自动推进；当 runtime 无法推导唯一安全下一步时，进入 controller decision，由主控裁决后继续。

当前代码仍是 v4 runtime 形态，已有 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report` 五个 public tools。本次实现不新增工具，先补齐主控裁决所需的工具契约。

## Scope

- `sp_status` / `controller_feedback` 返回 `allowed_controller_decisions`。
- `sp_start` 支持 `start_action="resolve_controller_decision"`。
- 第一版 decision 支持当前 runtime 能安全执行的动作：
  - `retry_node`
  - `continue_existing_graph`
  - `accept_partial_result`
  - `mark_blocked`
  - `request_reprepare`
- 不实现完整 v5 dynamic workflow patch / replace orchestration；`apply_workflow_patch`、`replace_orchestration` 不纳入本轮 `allowed_controller_decisions`。
- 保持 `expected_state_version` stale guard。

## Acceptance

- blocked / failed / waiting_user_decision / recovered_unknown / interrupted / dispatch_failed 状态下，`sp_status` 给出可选裁决。
- `sp_start(resolve_controller_decision)` 能根据裁决返回 fresh state 和 controller feedback。
- 不破坏已有 approve design、approve plan、resume input、retry interrupted node 流程。
- 补充单元测试覆盖 status 输出和 start 裁决。
