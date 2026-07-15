# Feature: needs_user 主控单入口（方案 A）

## 日期

2026-07-15

## 目标

`needs_user` 澄清统一走主控单入口，避免「主会话还挂着旧题、子会话里已经答了」导致重复提问。

## 规则

1. **提问展示**：`native` / `hybrid` 下仍只由主会话转述 `pending_question`（现有逻辑保留）。
2. **子会话停**：`sp_report(needs_user)` 后子会话应立刻停，不得复述问题或继续发下一问。
3. **子会话误答自动接手**：若用户仍在子会话里发消息，且该节点为 `needs_user`、workflow 为 `waiting_user`，插件在 `chat.message` 钩子里用该消息 `consumePendingQuestion`，把节点恢复为 `running`，再让本轮对话继续（不再要求用户另走主会话）。
4. **迟到 report 不重推**：`late_report_ignored` 后不再 `notifyParent` 重问旧题。

## 非目标

- 不改成在子会话前台弹原生 Question UI。
- 不把答案直接当 `passed` 自动推进下一阶段；只解除挂起并让原子会话继续。

## 验收

1. 主会话正式 `resume_input` 路径不变。
2. 子会话在 `waiting_user` 时回复 `A` → 出现 `user_input_resumed`，后续 `sp_report` 可被接受。
3. 迟到 `needs_user` report 被忽略时，主会话不会再次收到旧题通知。
4. 单测覆盖 late-ignore 短路与 child chat.message 自动 resume。

## 相关文件

- `src/tools/report-handler.ts`
- `src/state/store.ts`
- `src/plugin.ts`
- `src/runtime/child-answer-bridge.ts`
- `src/session/templates.ts`
- `src/skills/runtime-injection.ts`
- `docs/modules/session-orchestrator.md`
