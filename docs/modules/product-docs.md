# Product Docs Module

## Responsibility

product docs 记录 Superpowers Controller 的产品设计版本、PRD 来源和历史迁移关系。它不定义运行时代码契约；运行时代码契约仍以 `docs/modules/controller.md`、`docs/modules/state.md`、`docs/modules/session-orchestrator.md`、`docs/modules/agents.md` 和 `docs/modules/progress.md` 为准。

## Current PRD Source

当前 PRD 源：

- `docs/superpowers/specs/2026-06-27-controller-prd-v3.md`

历史版本：

- v1 / MVP: `docs/superpowers/plans/2026-06-09-superpowers-controller-mvp.md`
- v2 / final design: `docs/superpowers/specs/2026-06-11-controller-final-design.md`
- v2 migration plan: `docs/superpowers/plans/2026-06-11-controller-final-architecture-migration.md`

## Version Policy

- 新的产品级设计变更进入 `docs/superpowers/specs/`。
- 实现前的范围说明进入 `docs/features/` 或 `docs/bugfix/`。
- 实现后的模块契约进入 `docs/modules/`。
- 如果 PRD 和模块文档冲突，先以当前代码和模块文档核验，再回写 PRD。

## V3 Consolidation Notes

v3 PRD 合并了 v2 之后的运行时修订：

- public tool loop 收敛为 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- 节点结果工具从旧 `sp_record` 口径统一为 `sp_report`。
- `sp-spec-reviewer` 旧节点被 `sp-acceptance-reviewer` 替代。
- feature task 检查链调整为 task-scoped `acceptance -> verification -> code-review`。
- workflow user input 通过 parent controller session 和 `sp_start(resume_input)` 恢复，不再使用独立 TUI question route。
- progress/TUI 只提供可见性，不驱动 transition。
- startup recovery 不把 durable `running` 当成 live session。

