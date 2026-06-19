# Bug Fix: TUI Progress Missing Persistent Surface

## 问题描述

- 日期: 2026-06-19
- 严重程度: Medium
- 影响范围: Superpowers TUI progress visibility

用户要求在主会话界面展示子会话实时进度。已有实现只注册了 `superpowers-progress` route 和 `superpowers.progress` command，进度数据会被捕获和持久化，但默认 session 界面没有常驻展示区域。

## 根因分析

- 问题位置: `src/tui.ts`
- 原因: 实现把“可手动打开的 progress route”当成了“主界面实时可见”。OpenCode TUI route 不会自动显示在 session 页面；常驻展示需要注册 TUI slot。
- 代码流程: server plugin 写入 `nodes/<node-id>/progress.jsonl`，TUI route 可读取并渲染；但 session 页面没有 `session_prompt_right` 或 `sidebar_footer` slot，因此用户不打开 command 时看不到进度。

## 修复方案

- 修改 `src/tui/progress-panel.ts`：新增 `renderCompactProgressText()`，生成适合常驻区域的一行状态。
- 修改 `src/tui.ts`：继续保留完整 progress route，同时注册 `session_prompt_right` 和 `sidebar_footer` slot，在主会话页面显示最新 running node 进度。
- 修改测试：覆盖 compact 状态渲染、slot 注册和主会话过滤。

## 验证步骤

1. ✅ 确认运行日志中 child session 已创建，progress JSONL 正常追加。
2. ✅ 应用常驻 slot 修复。
3. ✅ 运行针对性测试。
4. ✅ 运行构建。

## 相关测试

- `bun test test/progress-panel.test.ts test/tui-plugin.test.ts`
- `bun run build`

## 设计建议

完整 panel 适合作为明细查看入口；主会话需要轻量、持续可见的 compact surface。后续如果 OpenCode 提供更专门的 live status API，可以把当前 `session_prompt_right` / `sidebar_footer` 输出迁移到更合适的 host slot。
