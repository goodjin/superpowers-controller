# Bug Fix: TUI Main Session Sidebar Progress

## 问题描述

- 日期: 2026-06-30
- 严重程度: Medium
- 影响范围: TUI resident slots `app_bottom` 和 `sidebar_content`

用户反馈：

1. 首页底部不应该展示 workflow 状态，只应在主会话页展示。
2. `sidebar_content` 仍然没有展示各子会话进度，右侧栏看起来只有主会话的 TodoWrite 调用列表。

## 根因分析

### 1. `app_bottom` 全局展示过宽

`src/tui.ts` 当前把 `app_bottom` 配置为：

```ts
{ renderer: "workflow-status", maxChars: 180, allowGlobal: true }
```

当首页或其它无 session props 的全局 slot 渲染时，`allowGlobal=true` 会让它直接读取 latest workflow，因此首页底部也会显示 workflow 状态。

### 2. `sidebar_content` 在新主控会话会被过滤为空

`sidebar_content` 会读取 slot 传入的 `session_id`。当前流程是：

1. `selectWorkflowCandidate(directory, sessionID)` 如果找不到包含该 session 的 run，会 fallback 到最新 unfinished workflow。
2. `progressModel()` 随后又检查 `sessionID` 是否属于该 workflow。
3. 如果新开的 `super-agent` 主控会话不是旧 workflow 的 `parent_session_id`，这个检查会返回 inactive model。

结果是：TUI 右侧栏有 plugin slot，但 slot 内容为空，用户只能看到 host 原生的 TodoWrite 区域。

## 修复方案

- `app_bottom` 改为 session-bound：不带 session props 时不渲染，避免首页底部显示 workflow。
- `sidebar_content` 保持全局能力，但对 `super-agent` 主控会话放宽 session 绑定：允许它展示最新 unfinished workflow 的子会话进度。
- 普通无关 session 仍不展示 workflow，避免把工作流状态泄露到不相关会话页。
- 无 session 的 sidebar global fallback 保持可用，继续作为 host 没传 session props 时的兜底。
- 扩展 unfinished workflow 列表，包含 approval、controller decision 和 failed 状态，避免异常态 sidebar 消失。

## 验证步骤

1. 添加 TUI 回归测试：
   - `app_bottom` 无 session props 时不显示。
   - `app_bottom` 带 parent session 时显示。
   - `sidebar_content` 在新的 `super-agent` session 上显示 latest workflow 子会话进度。
   - 普通 unrelated session 仍隐藏。
2. 运行 `bun test test/tui-plugin.test.ts test/progress-panel.test.ts`。
3. 运行 `bun run test`。
4. 运行 `bun run build`、`npm pack --dry-run`。
5. 重启 isolated superagent runtime。
