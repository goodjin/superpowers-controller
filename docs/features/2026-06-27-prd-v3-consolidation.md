# PRD V3 Consolidation

## Goal

把 `docs/superpowers/specs/2026-06-11-controller-final-design.md` 之后的 feature 和 bugfix 设计决策整理成 v3 PRD，作为当前实现口径的产品设计源。

## Scope

- 新增 `docs/superpowers/specs/2026-06-27-controller-prd-v3.md`。
- 保留 v1/MVP 和 v2/final-design 文档作为历史资料。
- v3 PRD 以 `docs/modules/*`、后续 feature/bugfix 记录和当前代码契约为准。
- 明确淘汰旧口径：`sp_record`、`sp_next`、`sp_reset`、`sp-spec-reviewer`、独立 TUI question route。
- 明确当前口径：`sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`，以及 task-scoped `acceptance -> verification -> code-review` 检查链。

## Sources

- `docs/superpowers/specs/2026-06-11-controller-final-design.md`
- `docs/features/runtime-workflow-tool-contract.md`
- `docs/features/task-scoped-acceptance-dispatch.md`
- `docs/features/check-failure-retry-and-main-progress.md`
- `docs/features/2026-06-26-e2e-runtime-recovery-coverage.md`
- `docs/bugfix/2026-06-26-workflow-resume-and-dispatch-consistency.md`
- `docs/bugfix/2026-06-26-nonblocking-workflow-dispatch.md`
- `docs/bugfix/2026-06-26-startup-interrupted-node-recovery.md`
- `docs/bugfix/2026-06-26-controller-owned-user-input-resume.md`
- `docs/bugfix/2026-06-26-sp-report-contract-and-progress-surface.md`
- `docs/bugfix/2026-06-27-inline-session-prompt-artifacts.md`
- `docs/modules/controller.md`
- `docs/modules/state.md`
- `docs/modules/session-orchestrator.md`
- `docs/modules/progress.md`
- `docs/modules/agents.md`
- `docs/modules/testing.md`

## Decisions

- v3 PRD 不再把 `sp_route` / `sp_next` / `sp_reset` 写成 public control surface。
- v3 PRD 不再使用 `sp_record` 命名；节点汇报统一叫 `sp_report`。
- v3 PRD 用 `sp-acceptance-reviewer` 替代旧的 `sp-spec-reviewer`。
- `parallel-investigate` 按当前实现记录为单 investigator 派发后进入 finish 汇总，不再承诺 v2 文档里的 independence-check / N investigators / synthesis 完整链路。后续如要恢复完整并行调查，需要单独立项。
- `progress` 是可见性和诊断信息，不是 workflow transition 输入。
- `runtime memory` 是运行时权威，durable files 是恢复和审计快照。

## Acceptance

- v3 PRD 覆盖当前 public tool loop、workflow 类型、agent/skill 边界、state model、dispatch/recovery、user input resume、progress/TUI、测试验收。
- v3 PRD 对 v1/v2 与当前实现差异给出清楚版本关系。
- 文档避免口号式表达，保持可执行、可检查。

