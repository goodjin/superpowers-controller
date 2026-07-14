# Bug Fix: waiting_user 后 parent/designer 都看不到提问

## 问题描述

- 日期: 2026-07-14
- 严重程度: High
- 影响范围: design/plan `needs_user` / 审批等待的用户可见提问

侧栏已显示 `waiting user` 与选项，但主会话与 designer 会话 transcript 都没有提问气泡。

## 根因分析

1. `userInputNotificationTarget` 对 design/plan 总是把通知投到 **foreground child**。
2. 默认 `interaction.mode=native` 让用户留在 **parent**，不会自动切到 child。
3. 通知用 `promptAsync` 打进刚跑完 `sp_report`、仍可能 busy 的 child，投递容易失败且 fire-and-forget。
4. 结果：用户盯着 parent，提问指令却打给没空/看不见的 child。

## 修复方案

- `native` / `hybrid`：用户输入/审批通知一律投到 `parent_session_id` + `superpowers-agent`，文案用 main conversation。
- `legacy`：仍投 foreground child（用户当时就在 child 前台）。
- `notifyParent` 在投递后 `selectSession` 到目标会话，保证视线落在会提问的那一侧。

## 验证

- 单测：native 下 design `needs_user` 通知 parent；legacy 下仍通知 design child。
- 实机：designer `needs_user` 后应切到主会话，并出现主控追问气泡。
