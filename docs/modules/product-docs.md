# Product Docs Module

## Responsibility

product docs 记录 Superpowers Controller 的产品设计版本、PRD 来源和历史迁移关系。它不定义运行时代码契约；运行时代码契约仍以 `docs/modules/controller.md`、`docs/modules/state.md`、`docs/modules/session-orchestrator.md`、`docs/modules/agents.md` 和 `docs/modules/progress.md` 为准。

## Current PRD Source

当前 PRD 源：

- `docs/superpowers/specs/2026-06-28-controller-prd-v5.md`

历史版本：

- v1 / MVP: `docs/superpowers/plans/2026-06-09-superpowers-controller-mvp.md`
- v2 / final design: `docs/superpowers/specs/2026-06-11-controller-final-design.md`
- v2 migration plan: `docs/superpowers/plans/2026-06-11-controller-final-architecture-migration.md`
- v3 / current implementation consolidation: `docs/superpowers/specs/2026-06-27-controller-prd-v3.md`
- v4 / recovery closure and managed preparation: `docs/superpowers/specs/2026-06-27-controller-prd-v4.md`

## Version Policy

- 新的产品级设计变更进入 `docs/superpowers/specs/`。
- 实现前的范围说明按仓库文档规范放置。
- 实现后的模块契约按模块文档规范放置。
- 如果 PRD 和模块文档冲突，先以当前代码和模块文档核验，再回写 PRD。

## V5 Prepare/Start Execution Notes

v5 PRD 将产品目标从固定 workflow definition 调整为 prepare-first task control 加 controller-selected start configuration：

- 插件不再把 `feature`、`debug`、`plan-only`、`review`、`verify-finish`、`parallel-investigate` 等固定流程作为主决策来源。
- 每个交给插件执行的任务都先调用 `sp_prepare`，写入或更新既有 run-local artifacts，例如 `request.md`、`documents.json`、`state.json` 和 `events.jsonl`，并生成用户确认摘要。
- 是否让 `sp-designer` 参与，由 controller 判断，并在 `sp_prepare` 阶段作为 brainstorming/design participation 触发；不是等 `sp_start` 后再启动设计节点。
- 用户确认 prepared execution task 后，controller 调用 `sp_start` 启动。
- `sp_start` 参数可以是内置 workflow 代号，也可以是自定义 workflow orchestration。
- 自定义 orchestration 允许只有一个节点。
- 是否允许 agent report 自动生成后续节点，默认由内置 workflow 名称约定和 workflow policy 决定；`design-only`、`plan-only`、`review-only` 等 `*-only` 默认不自动扩展，完整执行类 workflow 默认允许 guard 内扩展。
- 插件仍内置 `feature`、`bugfix`、`review`、`verify-finish`、`design-only`、`plan-only`、`review-only`、`parallel-investigate`、`single-agent` 等 workflow templates，方便 controller 选择、裁剪或忽略。
- `workflow_expansion` 显式给出 nodes/edges/documents；`task_graph` 只有在 task agent 或 auto expansion policy 的 `default_task_agent` 能确定目标 agent 时，才会被插件确定性转换为可执行节点。
- 插件不提供智能 workflow 规划；它只提供 agent catalog、workflow schema、built-in workflow templates、常用 workflow 示例、结构校验、状态机运行时、派发控制、`sp_report` 结果处理、恢复、取消和可见性。
- 内置 workflow templates 和常用 workflow 示例只作为 controller prompt 的规划参考，不是固定流程，也不是插件根据用户请求生成的建议。
- v5 增加 document contract：`request.md`、`spec.md`、`plan.md`、`task_graph.json`、`tasks.json`、task report 和 verification log 是 run 目录下的 workflow artifacts，由插件读取并内联传给后续 node。
- 每个 agent 完成后应调用 `sp_report`。如果 agent 没有调用，插件生成 fallback summary result，反馈 controller 决定 retry、接受 partial、取消或修改 workflow。
- v5 不新增 public tool，仍使用 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- v5 是新的设计目标；当前模块文档仍描述已实现的 v4 runtime contract，直到后续实现落地后再同步更新。

## V4 Recovery Closure Notes

v4 PRD 在 v3 基础上补齐异常路径闭合设计：

- 保持 public tool loop 为 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- 增加非终态 workflow 闭合规则：未结束 workflow 必须能解释等待、用户输入、计划批准、重试、取消、阻塞或结束。
- 将 `sp_prepare` 区分为 `proposal_only`、`managed_design` 和 `managed_planning`，避免 draft 路径缺少可批准设计或计划。
- 将 feature design 前移到 `sp_prepare(managed_design)`，`sp_start` 批准 design 后进入 planning，批准 plan 后进入 implementation。
- 增加 controller intake、designer question boundary、controller autonomy principles 和 plugin `controller_feedback` contract。
- 明确 `draft` 是状态，不是一等文档；未批准 design/plan 是 candidate output，批准后才 promotion 为 canonical artifact。
- 增加 approval promotion、`start_action`、`expected_state_version` 和 draft node startup recovery 设计；核心 promotion 和 stale approval guard 已在 runtime 落地。
- 增加 late report 隔离、approved artifact revision 后 stale/invalidation 的处理规则。
- 明确 progress report 不清空 `pending_question`，也不把 `waiting_user` 改回 `running`。
- 明确 dispatch failure、notification failure、canceled node、missing task graph 等异常状态的落盘和可见性；当前实现已覆盖可捕获 dispatch failure、canceled node、missing task graph 和 late report 隔离。
- 要求 `sp_start` 返回派发后的 fresh state。
- v4 仍有 prompt contract 层面的软约束，例如 designer question boundary 和 controller intake 质量主要由提示词引导；runtime 已实现核心状态、产物和反馈闭环。

## V3 Consolidation Notes

v3 PRD 合并了 v2 之后的运行时修订：

- public tool loop 收敛为 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- 节点结果工具从旧 `sp_record` 口径统一为 `sp_report`。
- `sp-spec-reviewer` 旧节点被 `sp-acceptance-reviewer` 替代。
- feature task 检查链调整为 task-scoped `acceptance -> verification -> code-review`。
- workflow user input 通过 parent controller session 和 `sp_start(resume_input)` 恢复，不再使用独立 TUI question route。
- progress/TUI 只提供可见性，不驱动 transition。
- startup recovery 不把 durable `running` 当成 live session。
