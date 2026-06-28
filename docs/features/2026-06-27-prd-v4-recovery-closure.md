# PRD V4 Recovery Closure

## Goal

在 v3 PRD 的基础上，把异常路径、恢复路径和用户等待路径补成闭合设计，形成 v4 PRD，作为后续实现和测试的产品依据。

## Background

v3 已经统一了 public tool loop、task-scoped 检查链、runtime memory 优先级、非阻塞派发、启动恢复、用户输入恢复和 progress surface。

进一步模拟各类运行场景后，发现 v3 对部分异常状态的退出条件写得不够硬：

- `sp_prepare` 的 draft preparation 路径容易只生成 draft，不生成可批准的 design 或 task graph。
- feature workflow 在 `start` 后才进入 design，designer 仍可能回问用户，用户体验像“已经开始执行又被拉回澄清”。
- controller intake 没有明确要求先问清用户侧问题，designer 容易承担本应由 controller 完成的澄清。
- controller 自主决策原则不够清楚，异常状态下容易在问用户、retry、cancel、continue 之间摇摆。
- 插件控制运行，但返回给 controller 的反馈结构不够稳定，controller 可能需要从状态和 progress 文本中反推下一步。
- `draft` 容易被误解为文档类型；未批准的 design/plan 不应进入 canonical artifacts。
- 系统重启后，draft node 的 stale running 状态需要恢复规则，不能因为 activation 是 draft 就跳过 reconciliation。
- `sp_start` 同时承担批准、恢复、retry，缺少显式 action 和 state version 容易误操作。
- interrupted 旧 child session 可能在 retry 后补交 late report，需要防止覆盖 newer attempt 或 canonical artifact。
- approved design/plan 后再 revision，会让 downstream plan/task graph 或未开始任务变旧，需要明确 stale/invalidation 规则。
- 单个 implement session 被 cancel 后，workflow 可能保持 running，但调度器没有下一步。
- `waiting_user` 状态下收到 progress report，可能错误清空 `pending_question`。
- child prompt 后台派发失败时，node 可能长期停在 running。
- parent notification 失败后，用户可能不知道 workflow 正在等输入。
- `sp_start` 返回值可能不是派发后的最新 state。
- feature workflow 在没有 task graph 时进入 generic implementer，容易跑偏。

## Scope

- 新增 `docs/superpowers/specs/2026-06-27-controller-prd-v4.md`。
- 将 v4 定位为 v3 之后的实现前设计稿。
- 明确所有非终态 workflow 都要有可解释的下一步决策。
- 将 feature 准备阶段调整为 `sp_prepare(managed_design) -> designer draft -> awaiting_design_approval -> sp_start -> planner draft -> awaiting_plan_approval`。
- 约束 controller intake 在 `sp_prepare` 前尽量问清用户侧问题。
- 约束 designer 只通过 prompt contract 询问设计阻塞问题，不做程序硬拒绝。
- 增加 controller autonomy principles 和 plugin `controller_feedback` contract。
- 明确 candidate output 与 canonical artifact 的边界：未批准的 design/plan 只保存在 node record/output，批准后才 promotion 成 `artifacts/spec.md`、`artifacts/plan.md` 和 `task_graph.json`。
- 明确 `sp_start` 使用 `start_action` 和 `expected_state_version` 区分 approve、resume、retry 和普通 start。
- 明确 draft workflow 的 startup recovery：activation 可以保持 draft，但 stale running draft node 必须标记 interrupted 并给出 retry/revise/cancel。
- 明确 late report 只作为审计或由 controller 决策接受，不直接覆盖 canonical state。
- 明确 approved design/plan revision 后的 stale artifact 和 downstream dispatch 处理。
- 明确异常场景下的状态落盘、用户可见性、恢复动作和验收用例。
- 更新 `docs/modules/product-docs.md`，把当前 PRD 源指向 v4。

## Design Decisions

- v4 不新增 public tool。仍沿用 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- v4 增加状态不变量：未结束 workflow 不能出现“没有 running node、没有 pending user input、没有 retry/cancel/finish 建议”的空转状态。
- v4 将 `sp_prepare` 收紧为 `proposal_only`、`managed_design`、`managed_planning` 三种可辨识模式，避免 draft 状态看起来已准备好但没有设计或计划产物。
- v4 把 feature design 前移到 `sp_prepare` 阶段，`sp_start` 先批准 design 进入 plan，再批准 plan 进入 implementation。
- v4 允许 controller 在原则约束下自主决策，插件通过 `controller_feedback` 给出事实、可选动作和阻塞原因。
- v4 不生成一等 `draft.md`；draft 是状态，candidate output 只有批准后才成为 canonical artifact。
- v4 要求 approval promotion 记录 source node、approver session、state version、events 和 changelog。
- v4 要求 late report 与 newer attempt 隔离；approved design/plan revision 会触发 stale/invalidation 规则。
- v4 要求 `waiting_user` 的问题只能由用户回答路径清空，progress report 不改变等待用户的事实。
- v4 要求 prompt scheduling failure 进入可恢复状态，并在 `sp_status` / TUI 中给出 retry 或 cancel 建议。
- v4 要求 `sp_start` 返回派发后的 fresh state。
- v4 将 “plan passed but no task graph” 视为需要显式用户确认或 blocker 的场景，不作为 feature workflow 的默认执行入口。

## Acceptance

- v4 PRD 覆盖 draft preparation、cancel、waiting user、dispatch failure、parent notification failure、stale return state、missing task graph 和 stalled running 等场景。
- v4 PRD 覆盖 controller intake、designer question boundary、controller autonomy 和 plugin feedback contract。
- v4 PRD 覆盖 candidate/canonical artifact、approval promotion、state version 防 stale approval、draft node startup recovery。
- v4 PRD 覆盖 late report、approved artifact revision 和 downstream stale handling。
- v4 PRD 提供状态决策表，能判断每类非终态 workflow 的下一步。
- v4 PRD 提供场景覆盖矩阵，用于后续实现前检查遗漏场景。
- v4 PRD 提供可测试的验收场景，后续实现可以直接转成测试用例。
- 文档保持产品设计口径，不在本次改动中修改 runtime 代码。
