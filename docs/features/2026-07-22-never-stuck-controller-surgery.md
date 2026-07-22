# Feature: 永不空转 + 主控手术刀

## 日期

2026-07-22

## 目标

任何时候调度不能静默卡住。推不动就回主控；主控可改图、取消节点、跳过前置后从任意节点强制启动。

## 原则

1. **遇事不决回主控**：无 running 子节点且推不出下一步 → `waiting_controller_decision` + `notifyParent`
2. **强制启动 = 先 skip 前置再派发**：被跳过的前置落成 `skipped` node_run，可审计
3. **非法 agent 归一**：未知 agent（如 `sp-executor`）默认当作 `sp-implementer`
4. **gate 只认 true**：报告里的 `false` gate 忽略，不覆盖已有 true

## A. 永不空转

触发：`decideNextDispatches` 得到 `[]`，且无 running 子节点，且 workflow 未终态。

动作：

1. `store.markNeedsControllerDecision({ reason })`
2. status → `waiting_controller_decision`
3. history / events 记 `empty_dispatch`
4. 调用方（`sp_report` / `sp_start` resume 路径）`notifyParent`

禁止：`status=running` 且无 child 且无下一步，却不通知主控。

## B. 主控手术刀

新增 / 放开 `ControllerDecisionKind`：

| kind | 行为 |
|------|------|
| `cancel_node` | 取消指定 node_run（或为未跑过的 spec 节点建 canceled 占位） |
| `skip_node` | 将 spec 节点标为 `skipped`，**满足 depends_on** |
| `force_dispatch` | 对目标节点：未满足的传递依赖全部 `skip_node`，再 `create_session` 派发目标 |
| `replace_orchestration` | 放开进 allowed 列表（整图替换） |

保留：`retry_node` / `continue_existing_graph` / `apply_workflow_patch` / `accept_partial_result` / `mark_blocked` / `request_reprepare`。

依赖满足规则：`passed` 与 `skipped` 均满足 `depends_on`；`canceled` 不满足。

## C. 护栏

- `normalizeTaskGraph` / `buildTaskGraphSpecNodes`：未知 agent → `sp-implementer`（记 warning 级 changelog/history 可选）
- `applyRecord`：只合并 `gates[k] === true`

## 验收

1. code-review 后空决策 → `waiting_controller_decision` + 主控被通知（复现 vpn M2-3 场景）
2. `force_dispatch` 到 finish：前置 task 节点为 `skipped`，finish 被派发
3. `skip_node` / `cancel_node` 单测通过
4. `sp-executor` task_graph 可跑（归一后 runnable）
5. verification 报告 `verification_fresh: false` 不抹掉已有 true（若本无 true 则仍为缺省）

## 相关文件

- `src/runtime/empty-dispatch.ts`（新建）
- `src/state/types.ts` / `store.ts` / `transitions.ts` / `task-graph.ts`
- `src/router/workflow-spec-dispatch.ts`
- `src/controller/feedback.ts`
- `src/tools/report-handler.ts` / `sp-start.ts`
- `test/empty-dispatch.test.ts` / `test/controller-surgery.test.ts`
