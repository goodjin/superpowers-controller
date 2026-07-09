# Bug Fix: TUI periodic progress popup

## 问题描述

- 日期: 2026-07-09
- 严重程度: Medium
- 影响范围: OpenCode TUI, Superpowers workflow progress visibility

TUI 会定时弹出工作计划或工作流进度提示框。用户要求工作进行中的会话列表展示在 `sidebar_content`，不应通过周期性弹窗、prompt 区域或主会话消息提示展示。

## 根因分析

- 问题位置: `src/session/parent-progress-notifier.ts`
- 调用入口: `src/session/orchestrator.ts`
- 原因: `ParentProgressNotifier` 每 10 秒读取 workflow progress，并调用 `adapter.showProgress()`。
- 当前 OpenCode adapter 的 `showProgress()` 优先调用 `ctx.client.tui.showToast()`，因此周期性 workflow progress 会表现为 TUI 弹出提示框。

## 修复方案

- 停止启动周期性 parent progress notifier。
- 保留 `sidebar_content` 的 workflow/session 展示作为主要运行状态 surface。
- 更新测试，断言 parent progress notifier 不再创建定时器、不再调用 prompt，也不再调用 toast/progress。

## 验证步骤

1. 运行 focused TUI / notifier tests。
2. 运行 build。
3. 本地安装后重启 OpenCode 验证 TUI 不再周期性弹出 progress toast。

## 相关测试

- `test/parent-progress-notifier.test.ts`
- `test/tui-plugin.test.ts`
- `test/progress-panel.test.ts`
