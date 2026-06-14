# Plugin-Led Orchestrator

## 背景

当前 Superpowers Controller 已经能注入 `super-agent` 和节点 agent，也能通过 `sp_route`、`sp_record`、`sp_next`、`sp_state`、`sp_reset` 保存基础 workflow 状态。这个版本更像状态记录器：模型调用工具后，插件记录 mode、phase、gate 和 artifact；下一步怎么派人、是否创建子会话、是否复用 session，仍然主要靠 prompt 约定。

目标是把插件推进到 control plane：主会话只做需求确认和状态查看；节点会话只执行插件派发的任务包；插件负责生成 proposal、启动 run、创建或复用节点 session、保存 node run、根据结构化 record 计算下一步。

## 当前缺口

- `sp_route` 命中 workflow 后会直接创建 run，缺少用户确认前的 proposal 阶段。
- 缺少明确的 intake/start 工具，`sp_record` 和 run 创建边界不清。
- controller 逻辑散落在 route/store/tool 内，没有 proposal、resume proposal 和启动参数整理模块。
- 没有 session adapter 和 orchestrator，插件还不能封装 OpenCode SDK 来创建/复用节点会话。
- `sp_record` 成功后只更新状态，没有统一计算 dispatch decision 并派发下一节点。
- `WorkflowState` 缺少 `node_runs`，无法追踪任务节点、session、attempt 和 record 文件。
- run 目录缺少 `proposal.md` 和 `nodes/*/task.md`。
- task graph 只有规范化写冲突，缺少可运行任务计算和失败依赖阻断。
- gate 未显式识别 controller agent，`super-agent` 仍可能执行生产写入。
- e2e 还没覆盖 proposal -> confirm/start -> 多节点 dispatch -> review -> verify -> archive 的长流程。

## 实现范围

- 新增 controller 模块：
  - `src/controller/proposal.ts` 生成 workflow proposal 和 resume proposal。
  - `src/controller/intake.ts` 将已确认 proposal 转成启动 run 的输入。
- 调整工具语义：
  - `sp_route` 只返回 proposal/resume proposal，不创建 run。
  - 新增 `sp_start`，由用户确认后创建 run，并写入 `request.md`、`proposal.md`、`changelog.md`。
- 新增 session 模块：
  - `src/session/adapter.ts` 封装 OpenCode SDK。
  - `src/session/templates.ts` 生成插件控制的 node task packet markdown。
  - `src/session/orchestrator.ts` 根据 dispatch decision 创建或复用节点会话。
- 新增 dispatch transition：
  - `src/router/transition.ts` 根据 state、record、task graph、node_runs 输出 dispatch decision。
  - `sp_record` 在持久化成功后计算下一步，并通过 orchestrator 派发。
- 扩展 state/store：
  - 在 `WorkflowState` 加入 `workflow`、`entrypoint`、`status`、`parent_session_id`、`node_runs` 等字段，同时保留旧 e2e 仍读取的 `mode`、`phase`、`session`。
  - 支持 `proposal.md`、`nodes/*/task.md`、`nodes/*/record.json`、`nodes/*/output.md`。
  - 支持 `startRun`、`recordNodeResult`、`addNodeRun`、`completeNodeRun`。
- 扩展 task graph：
  - `normalizeTaskGraph` 保留共享文件隐式依赖。
  - 新增 `getRunnableTasks`，依赖 passed 才可启动，failed 依赖链不启动。
- gate 补强：
  - `evaluateToolGate` 支持 agent/session 参数。
  - `super-agent` 的 mutating tool 在 strict 下阻断，guided 下 warning。

## 不做范围

- 不实现跨机器/远端持久化，run 仍保存在项目本地 `.opencode/superpowers/`。
- 不让模型决定 `next_action`、`child_session_id`、`reuse_session_id`、`create_sessions` 等 control-plane 字段。
- 不把 toast 进度写入模型上下文。
- 不做复杂的 child session 来源识别；第一版用插件生成的 node id/task id 建立闭环。
- 不删除现有兼容字段，避免当前 e2e 和旧状态读取一次性失效。

## 数据结构变化

`WorkflowState` 新增字段：

- `workflow`: workflow 类型，如 `feature`、`debug`、`review`。
- `entrypoint`: 确认启动的入口。
- `limited_context`: 是否从中间阶段启动。
- `parent_session_id`: controller 主会话 id。
- `status`: `intake`、`running`、`waiting_user`、`blocked`、`passed`、`failed`。
- `current_phase`: control-plane phase。
- `node_runs`: 节点运行列表。

`NodeRun` 结构：

- `id`
- `task_id`
- `phase`
- `agent`
- `primary_skill`
- `session_id`
- `status`
- `attempts`
- `started_at`
- `ended_at`
- `record_path`

run 目录新增：

- `proposal.md`
- `nodes/*/task.md`

## 新增工具或工具语义变化

- `sp_route`
  - 输入不变。
  - 返回 workflow proposal 或 resume proposal。
  - 不创建 run。
  - 返回字段包含 `workflow`、`entrypoint`、`requires_confirmation`、`markdown`、`next_action`。

- `sp_start`
  - 在用户确认后创建 run。
  - 输入包含 request、workflow、entrypoint、proposal markdown、session。
  - 返回创建后的 state 和下一步 dispatch summary。

- `sp_record`
  - 继续只接受节点结果结构。
  - 持久化 record 后计算 dispatch decision。
  - `needs_user` 只记录 pending question，不派发。

- `sp_next`
  - 返回 controller-facing dispatch summary，而不是节点执行 prompt。

## E2E 验收路径

长流程覆盖：

1. 用户提出需求，`sp_route` 返回 proposal，未创建 run。
2. 用户确认后，`sp_start` 创建 run，并写入 `request.md`、`proposal.md`、`changelog.md`。
3. intake/design/planner 节点按顺序提交 `sp_record`。
4. planner 提交 plan 和 task graph 后，多个 runnable task 触发多个 `sp-implementer` dispatch。
5. 每个 dispatch 写入 `node_runs` 和 `nodes/*/task.md`。
6. implementer 完成后进入串行 review：spec-review 先于 code-review。
7. code-review 通过后 dispatch verifier。
8. verification 通过后 dispatch finisher，finish 前 gate 要求 `verification_fresh`。
9. reset/archive 清除 active pointer，但 `.opencode/superpowers/runs/<run-id>/` 历史保留。
