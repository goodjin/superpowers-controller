# Bug Fix: design 前台子会话没有输入框

## 问题描述

- 日期: 2026-07-22
- 严重程度: High
- 影响范围: design 自动切到 designer 子会话后的交互

design 阶段 TUI 已切到子会话，但底部没有输入框，用户无法在子会话直接回答。

## 根因分析

1. native-only 下 node session 创建时带 OpenCode `parentID`，host 把页面当成原生 subagent route，默认隐藏普通底部 Prompt，只留 SubagentFooter 一类控件。
2. design foreground 自动 `selectSession(child)` 后，用户落在这条「无普通输入框」的路由上。
3. 插件虽有 `session_prompt` 注入，但在 native child route 上不够可靠，实际表现为完全不能输入。

## 修复方案

1. `sp-designer` 创建时省略 `parentID`，使用普通可交互 session 壳；逻辑父子仍由 `parent_session_id` / `node_runs` 维护。
2. `session_prompt`：只要当前 route 是任意 workflow child node，就注入 `api.ui.Prompt`（主控 route 仍为 null）。

## 验证

- `bun test test/session-adapter.test.ts test/tui-plugin.test.ts`
- `bun run build` + `bun run install:local`
- 实机：新 design 派发后切到子会话，底部有输入框，可直接回复。
