# Bug Fix: needs_user 回答后重复提问

## 问题描述

- 日期: 2026-07-15
- 严重程度: High
- 影响范围: design `needs_user` 澄清循环

用户回答澄清问题后，过一会主控又问同一道题。

## 根因分析

1. 正式路径要求主会话 `sp_start(resume_input)`，但用户在子会话直接回复。
2. 状态机未 `user_input_resumed`，`pending_question` 仍是旧题。
3. 子会话继续 `sp_report` 下一问 → `late_report_ignored`。
4. report-handler 仍按新记录走 `wait_user`，再次 `notifyParent` 重推旧题。

## 修复方案

- 方案 A：主控单入口 + 子会话误答自动桥接 `consumePendingQuestion`
- 迟到 report 短路，不再 notify
- 强化 needs_user 后停轮指引

## 验证

- `bun test ./test/child-answer-bridge.test.ts`
- 子会话 waiting_user 时回复 → 出现 `user_input_resumed`
- 迟到 needs_user report → 无二次 parent 通知
