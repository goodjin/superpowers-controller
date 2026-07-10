# Superpowers Controller 运行风险与工具缺口分析

> 基于插件运行流程模拟，整理各节点可能出现的中断风险，以及从模型视角观察到的工具覆盖缺口。
> 本文档只记录问题与建议方案，不涉及实现。

## 背景

Superpowers Controller 把职责分成三层：

- **superpowers-agent（主控）**：理解需求、调用 5 个 public tools、向用户确认；不直接写代码。
- **Plugin runtime**：状态机、派发、恢复、gate、持久化；不理解需求。
- **Node agents（sp-*）**：执行单节点任务、调用 `sp_report`；不决定 workflow 走向。

状态落在 `.opencode/superpowers/`。正常路径可以跑通；主要风险集中在「异常发生了，但 durable state 没跟上」以及「主控收到的恢复指引不够具体」。

---

## 问题 1：Provider / 会话错误不更新 durable state

### 问题描述

子节点执行过程中，如果 LLM provider 超时、网络中断、API 报错，OpenCode 会发出 `session.error` 事件。插件会把事件写入 `progress.jsonl`（`kind: session_error`），但 **durable state 里的 node 仍保持 `running`，workflow 也仍是 `running`**。

相关代码：`src/plugin.ts` 的 event hook 只处理 `waiting_permission`，不处理 `session.error`；`src/progress/node-progress.ts` 仅记录 progress，不回调 state store。

TUI 层有 `stalled` 检测（30 秒无 progress 事件，`STALLED_PROGRESS_AFTER_MS`），但这只是 UI 层推断，不会修改 state。`workflow-status.ts` 会给出 `inspect_or_cancel_stalled_node` 建议，但该建议没有进入 `controller_feedback.recommended_next`。

典型卡死路径：

```
sp_report(passed) → 派发 implementer → child session 启动
→ provider 超时 → progress 记录 session_error
→ durable state 仍是 running
→ 主控 sp_status 建议 wait_running_node
→ 用户看到界面不动，不知道该怎么办
→ 只有重启进程才会 reconcile 成 interrupted / recovered_unknown
```

**影响对象**：主控模型、用户、TUI 三方信息不一致。主控以为在等正常执行，实际 child 已死。

**严重度**：高。

### 建议解决方案

在 `plugin.ts` 的 event hook 中增加 `session.error` 处理逻辑：

1. 根据 `session_id` 定位对应 node。
2. 按错误类型更新 node 状态：
   - 明确不可恢复（401、模型不存在等）→ `failed`
   - 超时、rate limit 等 → 可配置为 `failed` 或 `interrupted`
   - 未知错误 → `interrupted`
3. 将 workflow 标为 `waiting_user_decision` 或 `waiting_controller_decision`。
4. 在 `controller_feedback` 中返回带 `task_id`、`node_id` 的 `retry_node` / `cancel` 裁决模板。

保留现有 `late_report_ignored` 机制，防止迟到 report 覆盖新状态。不新增 public tool，只丰富 runtime 状态转换和 feedback 返回。

---

## 问题 2：异步 prompt 投递失败只 toast，不写 state

### 问题描述

Session 创建成功后，给 child 发 prompt 是异步执行的（`scheduleNodePrompt`）。`sp_start` 或 `sp_report` 在登记 node 后即返回，不等待 prompt 完成。

如果异步的 `continueNodeSession` 失败，当前代码只在 catch 里调用 `showProgress` 弹 toast，**不更新 durable state**。

对比另一条失败路径：如果 `createNodeSession` 同步失败，会调用 `markDispatchFailed`，完整写入 `dispatch_failed` 状态和 `waiting_user_decision` workflow 状态。

相关代码：`src/session/orchestrator.ts` 第 261–290 行。

典型路径：

```
createNodeSession 成功 → addNodeRun(status=running) → 工具返回「派发成功」
→ 异步 continueNodeSession 失败 → 只弹 toast
→ durable state 有 running node，但没有 live session 在干活
```

**影响对象**：主控无法通过 `sp_status` 发现失败；TUI 可能后来显示 stalled，但仍是弱信号。与 session 创建失败的处理不对称，增加排查成本。

**严重度**：高。

### 建议解决方案

在 `scheduleNodePrompt` 的 catch 中调用 state 更新，复用 `markDispatchFailed` 或新增 `markPromptDeliveryFailed`：

1. 更新已有 `running` node 的状态，而不是新增 node。
2. 将 workflow 标为 `waiting_user_decision`。
3. 可选：区分失败阶段（`dispatch_failed` = session 创建失败；`prompt_delivery_failed` = prompt 投递失败），便于审计。
4. 在 `controller_feedback` 中给出 `retry_dispatch` 或 `retry_node` 建议。

默认仍保持 fire-and-forget 派发模型；仅 E2E 环境变量开启时 await prompt。补充集成测试覆盖异步失败路径。

---

## 问题 3：子代理崩溃或无 terminal report 时，只能靠重启发现

### 问题描述

如果 child 进程崩溃、被 kill、或 hang 住且没有提交 `sp_report`，durable state 会一直保持 `running`。插件没有 session liveness 检测或 heartbeat 机制。

只有以下时机才会发现异常：

- 用户重启 opencode / 插件进程 → `reconcileStartupState` 把 running node 标为 `interrupted`，workflow 变成 `recovered_unknown`
- TUI 30 秒后显示 stalled（但不改 state）

这与问题 1 同类：运行中的异常只进入观察层（progress / TUI），不进入决策层（durable state）。

**影响对象**：长时间假活；用户不知道 workflow 已死；主控持续建议等待。

**严重度**：高。

### 建议解决方案

分两层处理：

**短期（与问题 1 合并治理）**：在 event hook 中处理 `session.error` 和 `session.idle` 长时间无后续活动的组合信号，触发 state 降级。

**中期**：增加可选的 liveness 检测——若 node 为 `running` 且超过阈值（如 60s）无任何 progress 事件，自动标为 `interrupted` 并写入 history。阈值可配置。

两种路径都应在 `controller_feedback` 中给出恢复裁决，不依赖进程重启。

---

## 问题 4：进程重启后 recovered_unknown 的恢复指引过于粗糙

### 问题描述

进程重启后，若发现有 node 处于 `running`，启动协调（`reconcileStartupState`）会将其标为 `interrupted`，workflow 标为 `recovered_unknown`。这是正确的保守策略。

但主控收到的 `controller_feedback.recommended_next` 只返回：

```json
{ "action": "blocked", "reason": "workflow is recovered_unknown" }
```

`workflow-status.ts` 中有更具体的 `resume_or_cancel_recovered_workflow` 建议，包含原因说明和附加上下文，但 **`buildRecommendedNext` 没有引用这些信息**。

主控 prompt 虽然写了要用 `allowed_controller_decisions`，但模型仍需要自己推断：是先 `sp_status(detail=full)` 还是直接 `retry_node`，是否需要向用户确认。

**影响对象**：主控模型；恢复能完成，但步骤不清晰，容易多走一轮或问错问题。

**严重度**：中。

### 建议解决方案

对齐 `buildRecommendedNext` 与 `workflow-status.runtime_recommendation`：

1. `recovered_unknown` 时返回 `retry_node`（附 interrupted node 的 `task_id`、`phase`）和 `cancel_workflow`。
2. 在 feedback 中增加 `inspection_hints`，建议先调用 `sp_status(detail=full, include_progress=true)` 查看中断前的最后 progress。
3. 在 `requires_user` 中明确提示：「上次运行时进程中断，需向用户确认是重试还是取消」。

不新增 public tool，只丰富现有 tool 的返回值结构。

---

## 问题 5：三种「卡住」形态分散，主控难以统一处理

### 问题描述

用户感知上都是「workflow 不动了」，但系统内部有三种不同机制：

| 卡住形态 | 检测层 | durable state | 主控当前建议 |
|----------|--------|---------------|--------------|
| `recovered_unknown` | 启动协调 | `recovered_unknown` | `blocked`（粗糙） |
| `waiting_permission` | event hook + TUI | `running` | `wait_running_node` |
| `stalled` | TUI（30s 无 progress） | `running` | 仅在 workflow-status，不进 feedback |

三种形态的恢复动作不同（重试节点、去 child session 点批准、检查是否 provider 超时），但主控要从 progress 日志、TUI、feedback 多处自行推断，没有统一入口。

**影响对象**：主控模型；同一用户问题「怎么不动了」可能对应完全不同的处理路径。

**严重度**：中。

### 建议解决方案

在 `controller_feedback` 中按形态返回具体可执行建议：

| 形态 | recommended_next | 附加上下文 |
|------|------------------|------------|
| `recovered_unknown` | `retry_node` + `cancel_workflow` | interrupted node 列表 |
| `waiting_permission` | `wait_running_node` | 附 `session_id`、切换提示 |
| `stalled` | `inspect_or_cancel_stalled_node` | 附 `task_id`、`node_id`、停滞时长 |

可选增加 `inspection_hints` 字段，直接给出带参数的 `sp_status` 调用建议。让主控一次调用就能知道「卡在哪、下一步做什么」。

---

## 问题 6：notification_failed 在 PRD 有定义，实现几乎缺失

### 问题描述

PRD v4 定义了 `notification_failed` 状态：node 已进入 `needs_user`，但通知主控（parent session）失败。此时 `pending_question` 仍是事实来源，workflow 保持 `waiting_user`。

类型定义（`src/state/types.ts`）、TUI 排序（`src/tui/progress-panel.ts`）、`sp_start` 重试列表都支持了这个状态，但 **运行时代码几乎从不写入 `notification_failed`**。

实际行为：`report-handler.ts` 中 `notifyParent` 失败只弹 toast，`pending_question` 已写入 state，node 仍是 `needs_user`，不是 `notification_failed`。

**影响对象**：主控没收到通知时，可能一直等待，不知道有问题待回答；TUI 的 `notification_failed` 分支几乎不会触发。

**严重度**：中。

### 建议解决方案

1. `notifyParent` 失败时，将 node 标为 `notification_failed`，保留 `pending_question` 和 workflow `waiting_user`。
2. `sp_status` 在 `waiting_user` 且有 `pending_question` 时，无论是否收到通知，都输出问题全文。
3. `controller_feedback` 建议：直接向用户提问 → `sp_start(resume_input)` 继续。
4. 可选：后台重试 notify（低优先级，不阻塞恢复）。

不新增 public tool；`pending_question` 继续作为事实来源。

---

## 问题 7：dispatch_failed 与 prompt 失败的处理不对称

### 问题描述

Session 创建失败有完整恢复链路：`markDispatchFailed` → node `dispatch_failed` → workflow `waiting_user_decision` → `controller_feedback` 给出 `retry_dispatch` / `cancel`。

Prompt 投递失败（问题 2）没有对应链路。用户和主控难以理解「为什么一种派发失败能恢复，另一种不行」。

根因是设计选择：`scheduleNodePrompt` 被当作 fire-and-forget 副作用，失败不阻塞工具返回；而 `createNodeSession` 是同步 await，失败会抛到上层。

**影响对象**：排查体验；恢复策略一致性。

**严重度**：中（与问题 2 同源，此处强调体验层面）。

### 建议解决方案

统一两类失败的状态写入和 feedback 结构（详见问题 2 方案）。在 `controller_feedback` 中用同一套 `retry_dispatch` / `cancel_node` 建议，仅在 history / event 中区分失败阶段（`session_create_failed` vs `prompt_delivery_failed`），便于审计但不增加主控认知负担。

---

## 问题 8：编译 / 测试无插件级质量门禁

### 问题描述

AGENTS.md 要求 feature 完成后执行编译和打包再提交，但插件没有强制 build/test gate。节点可以通过 `sp_report(passed)` 让 workflow 进入 finish，即使 `bun run build` 从未执行或已失败。

现有 gate（`src/router/gates.ts`）只管流程纪律：

- `red_test_seen`：TDD 红测
- `design_approved` / `plan_written`：设计/计划审批
- `verification_gate`：约束完成声明格式，不约束是否真的跑过 build

`transition.ts` 在 finish 前检查 task graph 完成度，不检查 `checks` 字段中的构建证据。

**影响对象**：workflow 显示 `passed` 但代码可能编译不过；问题留到用户手动发现或 CI。

**严重度**：中。

### 建议解决方案

在 `StartConfig` 或 `workflow-spec.json` 中增加可选字段 `required_checks: ["build", "test", "lint"]`：

1. Verifier 节点契约：必须执行对应命令，结果写入 `sp_report.checks`。
2. 三级模式（与现有 gate 风格一致）：
   - `off`：现状，靠 skill 自觉
   - `guided`：缺 checks 时 warning
   - `strict`：缺证据不能 finish
3. Build 命令可配置（默认 `bun run build`）。
4. `transition.ts` 在 finish 前校验 `required_checks` 是否满足。

不新增 public tool；仍用 node 的 `bash` + `sp_report`。

---

## 问题 9：权限审批阻塞无程序化出口

### 问题描述

Child session 调用 bash/edit 等工具时，可能触发 OpenCode 权限审批（`waiting_permission`）。此时 workflow 仍是 `running`。

插件会 toast 并尝试 `selectSession` 切换到对应 child session，但 **主控和 runtime 都无法代替用户点击批准**。这是 OpenCode 平台限制，不是插件 bug。

主控 `sp_status` 建议 `wait_running_node`，不会明确告诉用户「需要去 child session 点批准」。

**影响对象**：无人值守场景会卡住；用户不知道卡点在哪。

**严重度**：低–中（平台限制，插件只能改善可见性）。

### 建议解决方案

在无法程序化 approve 的前提下，增强可见性：

1. `controller_feedback` 对 `waiting_permission` 附 `session_id` 和切换提示（如「请切换到 child session 批准权限」）。
2. TUI 已有 `waiting_permission` 排序优先级，确保这类节点置顶显示。
3. 主控 prompt 补充：看到 `waiting_permission` 时，明确提示用户去对应 session 操作。

不尝试绕过 OpenCode 权限系统。

---

## 问题 10：主控误操作被 gate 阻断时，反馈不够友好

### 问题描述

主控（superpowers-agent）被故意禁止直接写代码、加载 skill、创建 child session。这是职责分离设计。

但如果主控 prompt 遵守不好，可能跳过 `sp_prepare` 直接尝试 edit/bash，被 `gates.ts` 阻断。当前错误信息偏技术（如 `superpowers-agent cannot execute mutating production tools`），用户和模型不一定知道该怎么回到正确流程。

**影响对象**：新用户或不熟悉流程的模型版本；反复撞 gate，体验差。

**严重度**：低–中。

### 建议解决方案

在 `gates.ts` 对主控的阻断信息中加入可操作指引，例如：

> superpowers-agent 不能直接修改代码。请使用 sp_prepare 准备任务，由 node agent 执行代码修改。

可选：第一次违规时在 `controller_feedback` 中附 `recommended_next: revise_request` 或 `request_reprepare`。不改权限策略，只改错误文案。

---

## 问题 11：sp_start 工具 schema 过大，模型填参错误率高

### 问题描述

`sp_start` 支持 6 种 action（`start_prepared_task`、`resolve_controller_decision`、`resume_user_input` 等），每种有不同 payload 结构。`controller_decision`、`start_config`、`confirmation` 嵌套层级深。

大量模板和示例放在 tool schema 的 `description` 中，但动态信息（当前 `run_id`、`node_id`、`state_version`）要到调用失败后，才通过 `staleStateFeedback` 或 `allowed_controller_decisions.payload` 返回。

模型容易：

- 填错 `controller_decision` 结构
- 混淆 action 类型
- 遗漏 `state_version` 导致 stale 重试

**影响对象**：主控模型；多一轮 `sp_status` → 重试；token 消耗高。

**严重度**：低–中（有兜底，但效率差）。

### 建议解决方案

调整描述分发策略，不动 public tool 集合：

1. `sp_start` schema 只保留 action 枚举、必填字段、简短说明。
2. 大段 payload 模板移到 `sp_status` / `controller_feedback.allowed_controller_decisions[].payload`，每次返回带当前上下文的「可复制模板」。
3. stale 时 `staleStateFeedback` 直接附正确 payload，不只报版本不匹配。

实施后观察模型填参错误率是否下降。

---

## 问题 12：transition 仍硬编码，与 v5 spec-driven 目标不一致

### 问题描述

v5 PRD 和 feature 文档（`docs/features/2026-07-08-v5-alignment-gap-closure.md`）要求 dispatch 读取 `workflow-spec.json` 和 task graph 事实，而不是硬编码事件链。

当前 `src/router/transition.ts` 仍用大量 `switch (record.event)` 决定下一步：

- `design` → 派发 `sp-planner`
- `implementation` → 派发 `sp-acceptance-reviewer`
- `plan-only` → 直接 finish
- 等等

prepare/start 阶段已写入 `workflow-spec.json`，但「下一步派谁」仍靠代码里的固定分支。自定义 workflow 或非标准节点链需要改 `transition.ts`。

**影响对象**：长期扩展性；文档与实现不一致；designer/planner 产出的 spec 不能完全驱动执行。

**严重度**：低（短期，标准 feature 流程能跑）/ 高（长期，架构债）。

### 建议解决方案

分阶段向 spec-driven 收敛（可作为独立 feature 排期）：

1. 在 `workflow-spec.json` 中定义完整节点图：`event → agent → phase → depends_on → gates`。
2. `decideNextDispatches` 读取 spec + task graph + 当前 node_runs，替代 switch-case。
3. 现有 feature / debug / plan-only 流程收成默认 spec 模板。
4. 分阶段迁移：新 workflow 走 spec 路径，旧路径保留兼容层直到测试全覆盖。

不改 v5 公共 API；不新增 public tool。

---

## 问题 13：parent controller decision 通知失败时处理不完整

### 问题描述

当 workflow 进入 `waiting_controller_decision`（如 checker 失败、expansion 被拒），`report-handler.ts` 会尝试 `notifyParent` 通知主控做裁决。如果通知失败，只弹 toast：

```
Parent controller decision notification failed: ...
```

Workflow 状态已正确写入 `waiting_controller_decision`，`allowed_controller_decisions` 也在 state 中，但主控 session 可能没收到 prompt，不知道要裁决。

这与问题 6（`notification_failed`）类似，但发生在 controller decision 阶段而非 user input 阶段。

**影响对象**：主控模型；workflow 等着裁决但没人推动。

**严重度**：中。

### 建议解决方案

1. 通知失败时，在 `controller_feedback.blocking_reason` 中明确写出：「需要主控裁决，但 parent 通知失败，请主动调用 sp_status 查看 allowed_controller_decisions」。
2. 附完整的 `allowed_controller_decisions` payload 模板，主控不依赖 notify 也能继续。
3. 可选：写入 history 事件 `controller_decision_notification_failed`，便于审计。

---

## 问题 14：正常路径下主控不能做任何节点级工作（有意设计，依赖自律）

### 问题描述

主控只有 5 个 public tools（`sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`），被 gate 禁止 edit/bash/skill/task。节点只有 `sp_report` + 受限内置工具 + 一个 primary skill。

这是刻意的职责分离，正常路径工具足够。但整个流程纪律依赖：

- 主控 prompt 遵守程度
- 节点自觉执行 build/test 并如实 report
- 用户及时批准权限

任何一环松懈，就会出现 gate 阻断、假活、或质量漏检（分别对应问题 8、1–3、8）。

**影响对象**：全流程；不是单点 bug，是系统性依赖。

**严重度**：低–中（设计选择，靠其他问题的修复来加固）。

### 建议解决方案

不打破职责分离，通过加固其他环节降低风险：

1. P0 问题（1–3）修复后，异常能进 state，减少「靠自律发现」的环节。
2. P1 问题（4–6）修复后，主控指引更具体，降低模型走错路的概率。
3. 可选 build gate（问题 8）把质量纪律从 prompt 下沉到 runtime。
4. 在模块文档和主控 prompt 中明确「主控绝对不能做的事」和对应的正确 tool 路径。

---

## 优先级建议

| 优先级 | 问题编号 | 理由 |
|--------|----------|------|
| P0 | 1, 2, 3 | 直接导致 workflow 假活，主控无法恢复 |
| P1 | 4, 5, 6, 7, 13 | 恢复指引不足或 PRD 实现缺口 |
| P1 | 8 | 质量闭环，按需求强度选择 |
| P2 | 9, 10, 11 | 体验优化，改动小 |
| P2 | 12 | 架构债，单独排期 |
| — | 14 | 系统性依赖，随其他修复逐步加固 |

建议落地顺序：**2 → 1 → 6 → 13 → 4/5 →（按需 8）→ 11 → 12**。

---

## 相关文件索引

| 模块 | 路径 |
|------|------|
| 插件入口 | `src/plugin.ts` |
| 异步 prompt 投递 | `src/session/orchestrator.ts` |
| Progress 记录 | `src/progress/node-progress.ts` |
| 状态持久化 | `src/state/store.ts` |
| 状态转换 | `src/router/transition.ts` |
| Gate 评估 | `src/router/gates.ts` |
| Report 处理 | `src/tools/report-handler.ts` |
| 主控 feedback | `src/controller/feedback.ts` |
| Workflow 状态快照 | `src/status/workflow-status.ts` |
| TUI progress 面板 | `src/tui/progress-panel.ts` |
| 模块文档 | `docs/modules/controller.md`、`state.md`、`progress.md` |
