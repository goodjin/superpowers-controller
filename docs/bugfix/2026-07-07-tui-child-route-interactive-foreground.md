# Bug Fix: TUI Child Route Interactive Foreground

## 问题描述

- 日期: 2026-07-07
- 严重程度: High
- 影响范围: OpenCode TUI foreground child session interaction

foreground design/plan child 可以切到 OpenCode 原生 child session route，但切过去后必须继续是可交互、实时刷新的会话页面。上一版修复把行为改成始终留在 parent shell，这偏离了目标：问题不是不能切换到 child，而是 child route 前台后输入框和内容刷新不能像卡死。

## 根因分析

- `src/session/orchestrator.ts` 上一版把所有 foreground selection 都改回 `parent_session_id`，这会阻止设计要求中的 child route 前台展示。
- `src/tui.ts` 的 `session_prompt` slot 只在 parent session 上把 prompt 绑定到 foreground child；如果用户或 orchestrator 已经切到 child route，插件没有显式保证 child route prompt 绑定当前 child。
- child session command 被移除后，用户从 parent 返回 child 的入口也变弱。

## 修复方案

- design/plan foreground dispatch 重新选择 child session；parent-led 并行阶段仍选择 parent session。
- `session_prompt` slot 在当前 session 是 foreground child 时返回 `api.ui.Prompt({ sessionID: childID })`，保证切到 child route 后输入框仍提交到 child。
- parent session 上仍可把 prompt 绑定到 foreground child，用作 host 没有切换成功时的降级交互。
- TUI command 恢复 parent 和 child session 入口，但语义是切换当前 OpenCode session route，不再把它当作 parent-shell 嵌入。

## 验收标准

- design/plan dispatch 后选择对应 child session。
- 当前 route 是 foreground child 时，`session_prompt` 返回绑定同一个 child session 的 Prompt。
- 当前 route 是 parent 且有 foreground child 时，`session_prompt` 可绑定到 foreground child，作为降级路径。
- 命令面板包含 parent 和 child session 入口。

## 验证记录

- `bun test test/tui-plugin.test.ts test/session-orchestrator.test.ts test/session-adapter.test.ts`
- `bun run build`
- `npm pack --dry-run`
