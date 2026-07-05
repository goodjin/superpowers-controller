# Bug Fix: Foreground Child Confirmation Routing

## 问题描述

- 日期: 2026-07-05
- 严重程度: High
- 影响范围: design / plan 前台子会话体验

切换到 design 或 plan 子会话前台后，节点完成或请求确认时，确认提示仍被投递到 parent session。用户停留在当前子会话界面时看不到确认内容，workflow 看起来卡住，必须手动切回 parent 才能继续。

## 根因分析

- 问题位置: `src/tools/report-handler.ts`
- 原因: `decision.action === "wait_user"` 分支无条件调用 `orchestrator.notifyParent({ sessionID: current.parent_session_id, agent: "super-agent" })`。
- 设计遗漏: 上次实现只覆盖了 dispatch 后的前台 session 选择，没有调整 `sp_report` 产生等待确认状态后的通知目标。
- 关联问题: `buildControllerUserInputPrompt()` 只适合 `waiting_user + pending_question`，对 `awaiting_design_approval` / `awaiting_plan_approval` 会生成“waiting_user 但没有 pending_question”的误导提示。

## 修复方案

- 对 foreground serial node（design / plan）产生的等待状态，把确认提示投递回当前 child session。
- 对非 foreground 阶段继续通知 parent session。
- 扩展等待提示模板，使 design approval 和 plan approval 状态输出明确的 approve/revise/cancel 指引。
- 保持 durable `parent_session_id` 不变，child 只是当前交互前台。

## 验收标准

- design child 报告 passed 后，确认提示投递到 design child session，而不是 parent。
- plan child 报告 passed 后，确认提示投递到 plan child session，而不是 parent。
- 普通 `needs_user` 非前台阶段仍通知 parent。
- approval prompt 包含对应 `sp_start(...approve_design/approve_plan...)` 指引。

## 修复结果

- `report-handler` 根据 reporting node 的 phase 选择等待用户输入的通知目标。
- design / plan foreground child 的 approval prompt 和 needs_user prompt 留在当前 child session。
- 非 foreground 阶段仍通知 parent session。
- `buildControllerUserInputPrompt()` 支持 `awaiting_design_approval` 和 `awaiting_plan_approval`，不再把 approval 状态误报成缺少 `pending_question`。

## 验证步骤

1. ✅ `bun test test/sp-record-dispatch.test.ts test/session-orchestrator.test.ts test/controller-intake.test.ts`
2. ✅ `bun run build`
3. ✅ `npm pack --dry-run`
