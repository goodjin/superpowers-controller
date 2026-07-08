# Bug Fix: Parent progress updates bloating OpenCode context

## 问题描述

- 日期: 2026-07-08
- 严重程度: High
- 影响范围: Superpowers workflow parent session, OpenCode context length, long-running child workflows

Long-running workflows can repeatedly inject `Superpowers progress update` messages into the parent OpenCode session. In the observed VPN workflow, those periodic updates became the dominant session history payload and eventually made MiniMax-M3 requests fail with `context window exceeds limit (2013)`.

## 证据

- Parent session: `ses_0c35fbc61ffeEkePwddpxiOjBw`
- OpenCode DB:
  - `message`: 8348 rows, about 9.75 MB
  - `part`: 7728 rows, about 7.06 MB
  - `user/text`: 5113 rows, about 6.05 MB
  - `Superpowers progress update`: 5110 rows, about 6.045 MB
- Periodic update range: 2026-07-07 21:00:46 to 2026-07-08 11:12:43
- Last successful OpenCode token usage in the session: `tokens.total = 406248`

## 根因分析

- 问题位置: `src/session/parent-progress-notifier.ts`
- 当前实现每 10 秒通过 `adapter.continueNodeSession()` 给 parent session 发送一条 text prompt。
- OpenCode 把这类 prompt 按 user message 写入会话历史，因此每条定时进度都会进入后续模型上下文。
- 当 child session 长时间 stalled 但 workflow/node 仍保持 `running` 时，notifier 会继续发送重复进度。
- `session.prompt` 适合真正需要 parent agent 处理的通知，不适合高频状态刷新。

## 修复方案

1. 周期性 parent progress 不再调用 `continueNodeSession()`。
2. 改为通过 `adapter.showProgress()` 发布 progress surface/toast/log，避免进入会话上下文。
3. 对重复的 rendered progress 文本做去重，状态未变化时不重复发布。
4. 保持 workflow 结束或没有 active running child 时自动停止。
5. 更新测试覆盖“不写入 parent prompt”和“状态变化时发布 progress”。

## 验证步骤

1. 运行 `test/parent-progress-notifier.test.ts`
2. 运行相关 orchestrator/session 测试
3. 运行构建和打包检查

## 风险与边界

- 这只修改周期性进度更新；等待用户输入、审批等一次性 parent notification 仍可通过 `notifyParent()` 进入 parent session，因为它们需要主 agent 直接响应。
- TUI resident progress surface 仍然是实时状态的主要展示面。
