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

## README Positioning

`README.md` 和 `README.en.md` 面向首次了解项目的读者，结构保持一致：

- 先说明 Superpowers Controller 是用 Agent 使用 Superpowers 框架的方式。
- 再说明使用方式，先展示一行安装命令，再展示从源码编译安装路径，并说明安装器会把 OpenCode `default_agent` 设为 `superpowers-agent`。
- 接着解释设计理念：Agent 自动使用相关 Skill，plugin runtime 负责状态、调度、gate、持久化、恢复和审计，减少长上下文噪音导致的执行中断或流程跑偏。
- 最后说明执行链路、核心工具、内置 workflow、插件配置和开发验证方式。

README 不强调项目没有实现的入口形态或能力，避免让读者把注意力放到负向边界上。项目边界可以保留为独立项目和非上游官方插件的说明。

## V5 Prepare/Start Execution Notes

v5 PRD 将产品目标从固定 workflow definition 调整为 prepare-first task control 加 controller-selected start configuration：

- 插件不再把 `feature`、`debug`、`plan-only`、`review`、`verify-finish`、`parallel-investigate` 等固定流程作为主决策来源。
- 每个新的 `superpowers-agent` 会话第一轮 assistant 回复必须先输出固定欢迎语：`欢迎使用superpowers主控插件，我将按superpowers工作流程完成您的任务。`
- 每个交给插件执行的任务都先调用 `sp_prepare`，写入或更新既有 run-local artifacts，例如 `request.md`、`documents.json`、`state.json`、`events.jsonl` 和 prepare-stage `workflow-spec.json`，并生成用户确认摘要。
- 是否让 `sp-designer` 参与，由 controller 判断，并在 `sp_prepare` 阶段作为 brainstorming/design participation 触发；这些 prepare-stage 输出只补充 candidate context 和确认摘要，不构成启动后的固定 dispatch。
- 用户确认 prepared execution task 后，controller 调用 `sp_start(action="start_prepared_task", prepared_task_id, confirmation, start_config)` 启动。
- `start_config` 参数可以选择内置 workflow template，也可以提供自定义 workflow orchestration。
- 自定义 orchestration 允许只有一个节点。
- 是否允许 agent report 自动生成后续节点，默认由内置 workflow 名称约定和 workflow policy 决定；`design-only`、`plan-only`、`review-only` 等 `*-only` 默认不自动扩展，完整执行类 workflow 默认允许 guard 内扩展。
- 插件仍内置 `feature`、`bugfix`、`review`、`verify-finish`、`design-only`、`plan-only`、`review-only`、`parallel-investigate`、`single-agent` 等 workflow templates，方便 controller 选择、裁剪或忽略。
- `workflow_expansion` 显式给出 tasks/nodes/documents；auto expansion policy 允许时插件先 patch `workflow-spec.json` 和 task graph，再按更新后的 spec 派发；不允许时进入 `waiting_controller_decision` 并交给主控裁决。
- 插件不提供智能 workflow 规划；它只提供 agent catalog、workflow schema、built-in workflow templates、常用 workflow 示例、结构校验、状态机运行时、派发控制、`sp_report` 结果处理、恢复、取消和可见性。
- 内置 workflow templates 和常用 workflow 示例只作为 controller prompt 的规划参考，不是固定流程，也不是插件根据用户请求生成的建议。
- v5 增加 document contract：`request.md`、`spec.md`、`plan.md`、`task_graph.json`、`tasks.json`、task report 和 verification log 是 run 目录下的 workflow artifacts，由插件读取并内联传给后续 node。
- v5 展示策略复用 OpenCode 原生 child session：主内容区域尽量自动聚焦当前 running child session；右侧 sidebar 展示 workflow summary、total/running session counts、TodoWrite-style session list 和 shortcut hints；主会话保留确认、摘要、入口、attention 和按需 progress digest。
- v5 增加异常场景矩阵：系统重启、中断、失败、stalled、无 `sp_report`、`needs_user`、扩展校验失败、artifact 缺失和 late report 都要闭合到明确 controller decision。
- v5 public tools 仍保持五个；`sp_status(include_capabilities=true)` 返回 agent catalog、workflow schema、built-in templates 和 examples；`sp_status` 同时返回 `allowed_controller_decisions`，`sp_start(resolve_controller_decision)` 承载主控对异常路径的裁决。
- 每个 agent 完成后应调用 `sp_report`。如果 agent 没有调用，插件生成 fallback summary result，反馈 controller 决定 retry、接受 partial、取消或修改 workflow。
- v5 不新增 public tool，仍使用 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- v5 已落地到 runtime contract 的目标形态。旧 v4 参数仍可能作为兼容层或迁移测试存在，但新实现以 task brief、StartConfirmation、StartConfig、workflow spec、documents manifest、workflow expansion patch 和 controller decision 为主路径。

## V4 Recovery Closure Notes

v4 PRD 在 v3 基础上补齐异常路径闭合设计：

- 保持 public tool loop 为 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- 增加非终态 workflow 闭合规则：未结束 workflow 必须能解释等待、用户输入、计划批准、重试、取消、阻塞或结束。
- 将 `sp_prepare` 区分为 `proposal_only`、`managed_design` 和 `managed_planning`，避免 draft 路径缺少可批准设计或计划。v5 已把这组模式降级为兼容背景，主路径改为 prepare-stage workflow spec。
- 将 feature design 前移到 `sp_prepare(managed_design)`，`sp_start` 批准 design 后进入 planning，批准 plan 后进入 implementation。这是 v4 recovery closure 路径，不再作为 v5 当前行为描述。
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
