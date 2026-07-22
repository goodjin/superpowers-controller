# Feature: Controller Clean Handoff

## 日期

2026-07-22

## 目标

主控在 intake 理清需求并成功 `sp_prepare` 后，可按情况开启干净主控会话：只携带整理后的 brief / prepared task，甩掉冗长澄清聊天。

## 决策

1. **时机**：`sp_prepare` 成功后立刻 handoff。
2. **入口**：`sp_prepare(clean_handoff=true)`，不新增 public tool。
3. **策略**：主控按情况传参（澄清轮次多、上下文嘈杂时），不默认每次 prepare 都 handoff。

## 行为

当 `clean_handoff=true` 且 prepare 成功：

1. 创建顶层 `superpowers-agent` 会话（无 `parentID`）。
2. 将当前 prepared run 的 `parent_session_id` / `session` 重绑到新会话。
3. 向新会话注入精简 handoff prompt（prepared_task_id、confirmation_summary、task_brief 摘要、产物路径、下一步）。
4. TUI 切到新会话。
5. prepare 返回体附带 `clean_handoff` 结果；旧会话应停止继续当主控。

## 非目标

- 不删除旧会话。
- 不替代 `sp_start` 确认流程；新会话仍要展示确认摘要，用户确认后再 `sp_start`。
- 不压缩旧会话历史；靠新会话隔离上下文。

## 影响文件

- `src/tools/sp-prepare.ts`
- `src/session/adapter.ts`
- `src/session/orchestrator.ts`
- `src/session/templates.ts`（handoff prompt）
- `src/state/store.ts`（parent rebind）
- `src/agents/index.ts`
- `test/controller-intake.test.ts`
- `docs/modules/controller.md`
- `docs/modules/session-orchestrator.md`

## 验收

- `sp_prepare(clean_handoff=true)` 成功后返回新 `session_id`，state.parent 指向新会话。
- 未传 `clean_handoff` 时行为与现网一致。
- 新会话收到 handoff prompt；TUI select 被调用。
- 相关单测通过；`bun run build` 通过。
