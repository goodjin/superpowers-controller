# Product Docs Module

## Responsibility

product docs 记录 Superpowers Controller 的产品设计版本、PRD 来源和历史迁移关系。它不定义运行时代码契约；运行时代码契约仍以 `docs/modules/controller.md`、`docs/modules/state.md`、`docs/modules/session-orchestrator.md`、`docs/modules/agents.md` 和 `docs/modules/progress.md` 为准。

## Current PRD Source

当前 PRD 源：

- `docs/superpowers/specs/2026-06-27-controller-prd-v4.md`

历史版本：

- v1 / MVP: `docs/superpowers/plans/2026-06-09-superpowers-controller-mvp.md`
- v2 / final design: `docs/superpowers/specs/2026-06-11-controller-final-design.md`
- v2 migration plan: `docs/superpowers/plans/2026-06-11-controller-final-architecture-migration.md`
- v3 / current implementation consolidation: `docs/superpowers/specs/2026-06-27-controller-prd-v3.md`

## Version Policy

- 新的产品级设计变更进入 `docs/superpowers/specs/`。
- 实现前的范围说明进入 `docs/features/` 或 `docs/bugfix/`。
- 实现后的模块契约进入 `docs/modules/`。
- 如果 PRD 和模块文档冲突，先以当前代码和模块文档核验，再回写 PRD。

## V4 Recovery Closure Notes

v4 PRD 在 v3 基础上补齐异常路径闭合设计：

- 保持 public tool loop 为 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- 增加非终态 workflow 闭合规则：未结束 workflow 必须能解释等待、用户输入、计划批准、重试、取消、阻塞或结束。
- 将 `sp_prepare` 区分为 `proposal_only`、`managed_design` 和 `managed_planning`，避免 draft 路径缺少可批准设计或计划。
- 将 feature design 前移到 `sp_prepare(managed_design)`，`sp_start` 批准 design 后进入 planning，批准 plan 后进入 implementation。
- 增加 controller intake、designer question boundary、controller autonomy principles 和 plugin `controller_feedback` contract。
- 明确 `draft` 是状态，不是一等文档；未批准 design/plan 是 candidate output，批准后才 promotion 为 canonical artifact。
- 增加 approval promotion、`start_action`、`expected_state_version` 和 draft node startup recovery 设计。
- 增加 late report 隔离、approved artifact revision 后 stale/invalidation 的处理规则。
- 明确 progress report 不清空 `pending_question`，也不把 `waiting_user` 改回 `running`。
- 明确 dispatch failure、notification failure、canceled node、missing task graph 等异常状态的落盘和可见性。
- 要求 `sp_start` 返回派发后的 fresh state。
- 将 v4 标记为后续实现目标；当前代码是否完全符合 v4 仍需实现和测试验证。

## V3 Consolidation Notes

v3 PRD 合并了 v2 之后的运行时修订：

- public tool loop 收敛为 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- 节点结果工具从旧 `sp_record` 口径统一为 `sp_report`。
- `sp-spec-reviewer` 旧节点被 `sp-acceptance-reviewer` 替代。
- feature task 检查链调整为 task-scoped `acceptance -> verification -> code-review`。
- workflow user input 通过 parent controller session 和 `sp_start(resume_input)` 恢复，不再使用独立 TUI question route。
- progress/TUI 只提供可见性，不驱动 transition。
- startup recovery 不把 durable `running` 当成 live session。
