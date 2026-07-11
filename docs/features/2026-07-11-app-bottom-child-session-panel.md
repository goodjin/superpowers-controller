# Feature: App Bottom Child Session Panel

## 背景

用户希望在 parent 主会话区域看到子会话进展，但不想依赖 OpenCode 原生 Task 卡片（会污染 controller 模型）。`sidebar_content` 已在右侧展示列表，主列底部 `app_bottom` 仍只是一行摘要，信息量不足。

## 目标

1. 去掉重复的 `sidebar_footer` 注册。
2. 将 `app_bottom` 升级为多行「伪 task 条」：workflow 摘要 + 子会话列表 + 快捷键提示。
3. 注册 `⌘1`–`⌘9` 与 `⌘[` / `⌘]` 快捷键，跳转到对应 child session（`api.keymap.registerLayer`；旧 host 保留 command palette fallback）。

## 非目标

- 不向 parent transcript 注入进度消息。
- 不模拟原生 Task tool part。
- 不在本 feature 中恢复 `parentID` 或修改 dispatch 后自动切 child 策略。

## 验收

- `app_bottom` 无 session props 时显示多行 child 面板。
- 面板行含 `>` 聚焦标记、`[⌘n]` 快捷键、agent/task、状态与摘要。
- 有 active workflow 时注册 keymap；`⌘1` 导航到列表第一个 child session。
- `sidebar_footer` 不再注册。
