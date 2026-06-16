# Controller Module

## Responsibility

controller 模块负责把用户请求从“意图识别”推进到“可确认的 workflow proposal”，并在用户确认后整理启动 run 的参数。它不创建子会话，也不写 node record；这些分别交给 session orchestrator 和 state store。

## Files

- `src/controller/proposal.ts`：生成 workflow proposal 和 resume proposal。
- `src/controller/intake.ts`：把确认后的 proposal 转成 `startRun` 输入。
- `src/tools/sp-route.ts`：调用 proposal builder，只返回 proposal，不创建 run。
- `src/tools/sp-start.ts`：确认后创建 run，写入 request/proposal/changelog。
- `src/progress/reporter.ts`：为 route/start 提供用户可见的流程提示契约。

## Flow

1. `sp_route` 接收 request/command。
2. controller 读取 active state。
3. 如果没有 active run，按 route 结果生成 proposal：
   - `workflow`
   - `entrypoint`
   - `requires_confirmation`
   - `markdown`
   - `next_action`
4. 如果已有 active run，生成 resume proposal。
5. 用户确认后，`sp_start` 调用 `prepareExplicitStartRun()`，再由 store 创建 run。
6. `sp_route` 发送 `waiting_user_confirmation` progress，`sp_start` 发送 `run_started` progress。

## Notes

- `sp_route` 不创建 run，这是 proposal-before-run 的验收边界。
- `/sp-execute` 会启动 `feature` workflow，但 entrypoint 是 `execute`，用于从中间阶段进入执行门禁。
- proposal markdown 给用户和 super-agent 读；插件判断只依赖结构化字段。
- progress 是 side-channel UI/log 提示，不进入模型上下文，也不改变确认语义。
- 产品展示名是 `Superpowers Controller`。当前模块运行在 OpenCode adapter 上，但 controller 的职责描述不应绑定单一 harness。
