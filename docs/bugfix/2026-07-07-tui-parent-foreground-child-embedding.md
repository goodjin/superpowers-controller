# Bug Fix: TUI Parent Foreground Child Embedding

> Superseded on 2026-07-07 by `docs/bugfix/2026-07-07-tui-child-route-interactive-foreground.md`. Foreground child sessions may be selected directly; the fix is to keep the child route interactive and live, not to forbid switching.

## 问题描述

- 日期: 2026-07-07
- 严重程度: High
- 影响范围: OpenCode TUI workflow foreground interaction

当前实现把 design/plan child session 通过 OpenCode 原生 session route 直接切到前台。这个行为会把整个 TUI 当前会话切成 child，底部输入框和返回路径也跟着切换。用户回到 parent session 后，child session 的实时内容和交互入口不再稳定可见，容易出现“看起来卡住、回不去 child”的体验。

## 根因分析

- `src/session/orchestrator.ts` 的 `selectWorkflowSession()` 对 design/plan 调用 `selectSession(childID)`，这是全局 session route 切换，不是 parent 区域内嵌 child 内容。
- `src/tui.ts` 上一次新增的 command 也调用 `route.navigate("session", { sessionID: childID })`，继续强化了全局切会话的模型。
- OpenCode TUI 插件 API 已提供 `api.state.session.messages(sessionID)`、`status()`、`permission()`、`question()` 和 `api.ui.Prompt({ sessionID })`，更适合在 parent route 里展示/绑定 foreground child，而不是切走原生 session route。

## 修复方案

- workflow 自动前台选择不再把 route 切到 child；dispatch 后保持或回到 `parent_session_id`。
- TUI 注册 `session_prompt` slot：当当前 session 是 parent 且存在 foreground design/plan child 时，底部 prompt 仍显示在 parent 页面，但提交目标绑定到 child session。
- `sidebar_content` 追加 foreground child 的 live transcript 摘要、permission 和 question 状态，避免只显示 progress JSONL 而看不到 child 会话最新内容。
- child session command 不再直接跳到 OpenCode 原生 child route，避免用户再次进入不可回退的全局切换路径。

## 验收标准

- design/plan child running 或 awaiting approval 时，parent session 的 prompt target 是对应 child session。
- dispatch design/plan 后不再自动 `selectSession(childID)`；仍保持 parent route。
- parent sidebar 能显示当前 foreground child 的最近消息、permission/question 数量和 live status。
- 没有 foreground child 时，不影响 parent-led 并行阶段和普通 session prompt。

## 实施记录

- Earlier implementation adjusted foreground session selection so all dispatches stayed on or returned to `parent_session_id`; this was superseded because foreground child route switching is allowed.
- `src/tui.ts` 注册 `session_prompt` slot，并在 parent session + foreground design/plan child 时用 `api.ui.Prompt({ sessionID: childID })` 绑定提交目标。
- `src/tui.ts` 的 `sidebar_content` 在已有 workflow progress 后追加 foreground child 的 live transcript、permission/question 数量和 live status。
- Earlier implementation restricted route commands to the workflow parent; this was superseded by restoring parent and child route entries.

## 验证记录

- `bun test test/tui-plugin.test.ts test/session-orchestrator.test.ts test/session-adapter.test.ts`
- `bun test test/controller-intake.test.ts -t foreground`
- `bun run build`
- `npm pack --dry-run`
