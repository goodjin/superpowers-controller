# Bug Fix: session_prompt hint 裸字符串导致 OpenCode 崩溃

## 问题描述

- 日期: 2026-07-14
- 严重程度: Critical
- 影响范围: OpenCode TUI（整窗 crash）

启动/使用 workflow 时出现：

```text
Orphan text error: "SP -> sp-acceptance-reviewer t09-ui" must have a <text> as a parent: box-272 above text-node-716
```

## 根因分析

- 问题位置: `src/tui.ts` → `createForegroundChildPromptSlot` → `api.ui.Prompt({ hint: "SP -> ..." })`
- 原因: OpenCode 1.17.20 的 Prompt 渲染里，`hint` 会**原样**作为子节点插入（`U.hint ?? <box><text>...</text></box>`）。传入字符串会变成挂在 `box` 下的 orphan text node，OpenTUI 直接 fatal。
- 另一路径：无 `api.ui.Prompt` 时 `session_prompt` 曾直接 `return "SP foreground child: ..."` 裸字符串，同样不安全。

## 修复方案

- 停止向 `api.ui.Prompt` 传入 `hint`（该 prop 在宿主中按裸 children 插入）
- 用 `placeholders.normal` 提示 `Reply to <agent>`，保留 `sessionID` 绑定
- 无 `api.ui.Prompt` 时返回 `null`，不再返回裸字符串
- 相关测试更新

## 验证步骤

1. `bun test test/tui-plugin.test.ts`
2. `bun run install:local` 后重启 OpenCode
3. 进入有 foreground child 的 parent/child 会话，确认不再 crash，输入区仍可用
