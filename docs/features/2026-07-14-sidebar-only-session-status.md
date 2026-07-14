# Feature: 会话状态只留 sidebar，并让活动文案可读

## 背景

OpenCode TUI 插件同时在 `app_bottom`（主会话底部）和 `sidebar_content`（侧栏）展示会话/workflow 状态。侧栏可用后，主区底部再叠一层会显得重复。

侧栏会话行里还有两类不清晰文案：

- `↳ Sp_status`：看起来像「正在调用」，实际可能是最近一次已完成的工具
- `unknown -`：host 没给出 live status、标题又为空时的占位

## 目标

1. 取消注册 `app_bottom`，会话状态只通过 `sidebar_content` 展示。
2. 保留 `session_prompt`（输入代理/前台 child 提示，不是底部状态条）。
3. 侧栏活动文案：
   - 正在跑的工具：`calling Sp_status`
   - 空闲时最近工具：`last Sp_status`
   - 无 live status 时显示 `idle`，不再出现 `unknown -`

## 非目标

- 不恢复 JSX sidebar 组件路径
- 不改 server plugin / workflow 状态机

## 验收

- `RESIDENT_PROGRESS_SLOT_NAMES` 不含 `app_bottom`
- 相关测试更新并通过
- 本地 `install:local` 后重启 OpenCode：主区底部无 Superpowers 状态条，侧栏仍有；活动行不再出现裸 `unknown -`
