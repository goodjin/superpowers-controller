# Session Orchestrator Module

## Responsibility

session orchestrator 模块把 dispatch decision 变成 OpenCode node session。它生成插件控制的 task packet，调用 session adapter 创建或复用 session，并把 task markdown 返回给 store 写入 `nodes/*/task.md`。

## Files

- `src/session/task-packet.ts`：node task packet 类型。
- `src/session/templates.ts`：把 packet 渲染成 node prompt，并声明 primary skill 和 `sp_record` contract。
- `src/session/adapter.ts`：封装 OpenCode SDK 的 `session.create`、`session.prompt`、`tui.showToast`。
- `src/session/orchestrator.ts`：根据 create/reuse dispatch 调用 adapter。
- `src/router/transition.ts`：生成 orchestrator 消费的 dispatch decision。

## Dispatch Contract

orchestrator 接收：

- `project`
- `runID`
- `parentSessionID`
- `decision`
- `packet`

返回：

- `action`
- `session_id`
- `task_markdown`

store 随后用这些信息创建 `node_runs`，并写入 `nodes/<node-id>/task.md`。

## E2E Behavior

生产默认行为是创建 node session 后提交 task prompt。OpenCode e2e 设置 `OPENCODE_SUPERPOWERS_DISABLE_CHILD_PROMPT=1`，只验证真实 session 创建、状态持久化和 task packet 写入，避免 mock LLM 需要为 child session 额外注册模型响应。

## Notes

- 节点 prompt 只声明一个 primary skill。
- 模型不能在 `sp_record` 中提交 `next_action`、`child_session_id`、`reuse_session_id` 或 `skills_used`。
- retry dispatch 优先复用原 implementer session；无法复用时由 transition 创建新的 implementer decision。
