# Bug Fix: TUI Child Session Return Command

> Superseded on 2026-07-07 by `docs/bugfix/2026-07-07-tui-parent-foreground-child-embedding.md`. Child session route jumping was replaced by parent-shell foreground child prompt binding.

## 问题描述

- 日期: 2026-07-05
- 严重程度: High
- 影响范围: TUI workflow session navigation

workflow 可以自动从 child session 切回 parent session，但用户回到 parent 后缺少稳定入口跳回某个 child session。并行阶段或调试时，用户只能看到 parent 进度，无法方便打开具体 child 查看上下文。

## 根因分析

- 问题位置: `src/tui.ts`
- 原因: TUI 插件只注册了 progress route 和 resident slots，没有注册 session navigation command。
- 结果: 自动切换是单向体验，用户无法从 Superpowers UI 重新选择 parent/child session。

## 修复方案

- 在 TUI 插件里注册动态 command。
- command 从当前 workflow state 生成 parent session 和 child node session 入口。
- 选中 command 后调用 `api.route.navigate("session", { sessionID })`。
- 保持 resident progress slot 不承担输入或按钮职责。

## 验收标准

- 有 active workflow 时，命令面板包含 parent session 和 child session 跳转项。
- 选择 child command 后导航到对应 session。
- 没有 workflow 时不暴露无效 session command。

## 实施记录

- `src/tui.ts` 注册动态 command，基于当前 workflow state 生成 parent/child session 跳转项。
- `test/tui-plugin.test.ts` 覆盖命令标题和选择 child command 后的 `sessionID` 导航参数。
- `docs/modules/progress.md` 和 `docs/modules/testing.md` 已同步更新 TUI command 行为。

## 验证记录

- `bun test test/tui-plugin.test.ts`
- `bun run build`
- `npm pack --dry-run`
