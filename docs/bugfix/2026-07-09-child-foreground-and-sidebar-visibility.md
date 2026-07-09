# Bug Fix: Child Foreground And Sidebar Visibility

## 问题描述

- 日期: 2026-07-09
- 严重程度: High
- 影响范围: OpenCode TUI child session foreground selection and sidebar visibility

workflow 进入 implement 等 task graph 阶段后，controller 已经创建并运行 child session，但 OpenCode TUI 没有切到该 child；当 child 触发权限确认时，用户仍停留在 parent/controller 会话，sidebar 也没有把当前 child 的 live permission 状态展示出来，表现为“又回去了、运行子会话时没有切换过去、sidebar 没信息”。

## 根因分析

- `src/session/orchestrator.ts` 仍把非 design/plan 阶段视为 parent-led，并在 dispatch 后选择 `parent_session_id`，因此 implement child 不会成为前台会话。
- `src/tui.ts` 的 foreground child 判定只包含 design/plan running 或 approval child，implement/acceptance/verification/code-review 等 running child 不会触发 sidebar live transcript 和 permission/question 摘要。
- 即使 dispatch 时尝试切换，权限确认通常在 child 运行一段时间后才出现；如果用户已经切回 parent、host 没执行前一次 select，或插件是在旧版本下派发的 child，waiting permission 事件仍可能留在 child 内部不可见。
- 当前运行日志显示 active implement child 正在等待 `edit` 权限，但没有对应的 `tui.session.select` 记录；state 中 `parent_session_id` 已正确重绑到新 controller session，说明这不是旧 parent rebound 问题。

## 修复方案

- dispatch 创建或复用 node session 后，默认请求 TUI 选择该 child session，让用户直接看到实际运行和权限确认界面。
- 监听 child `session.status=waiting_permission` 事件；当已登记 child 进入权限等待时，再次请求 TUI 选择该 child，并发 warning toast。
- sidebar foreground child 判定扩展到当前 running child；如果存在等待权限的 running child，优先展示它的 live status、permission/question 数量和最近消息。
- 更新测试，覆盖 implement dispatch 前台选择 child，以及 running implement child 在 sidebar 中显示 foreground live 区。
- 更新模块文档，说明 parent 身份和前台 route 是两个概念；前台选择用于可见性和权限确认，不改变 workflow parent。

## 验收标准

- implement dispatch 后调用 `selectSession(childID)`，而不是切回 parent。
- child session 进入 `waiting_permission` 后，即使此前没有停留在 child route，也会再次触发 `selectSession(childID)` 并显示 warning toast。
- parent 或 child route 的 sidebar 能显示当前 running child 的 live status，并在权限等待时显示 permission 计数。
- existing workflow parent rebind 语义不变；child 调用 `sp_start` 不抢占 parent 身份。
