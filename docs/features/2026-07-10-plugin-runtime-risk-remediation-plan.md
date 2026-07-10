# Plugin Runtime 风险修复计划

> 基于 `docs/analysis/2026-07-10-plugin-runtime-risk-and-tool-gap.md` 与当前代码核对结果。
> 目标：让异常进入 durable state，让主控一次 `sp_status` 就能知道「卡在哪、下一步做什么」。
> 不新增 public tool；不打破 controller / node 职责分离。

## 设计理念对齐（验收基准）

与 PRD V5 §9、哲学文档 §2.4–2.5 一致：**插件只控流，主控做裁决**。

### 职责边界

| 角色 | 异常时做什么 | 不做什么 |
|------|-------------|---------|
| **插件 runtime** | 记录事实、闭合假活状态、进入有限决策点、通过现有 5 个 public tool 暴露裁决菜单 | 理解用户意图、自动 retry/cancel/skip、替主控选恢复策略 |
| **主控 agent** | 读 `sp_status`、结合用户目标选 `allowed_controller_decisions`、用 `sp_start(resolve_controller_decision)` 提交 | 直接改代码、绕过 gate 派活、发明 PRD 外的 decision kind |

### 异常闭环三步（所有 Phase 1/2 项须满足）

```text
1. 记录事实   node/workflow 状态从 running 落到可审计终态或卡点态
              （interrupted / failed / dispatch_failed / notification_failed 等）
2. 进入决策点 workflow.status → waiting_controller_decision
              （或 PRD 已定义的 awaiting_*_approval / waiting_user，见下）
3. 暴露工具   sp_status.controller_feedback 返回：
              - blocking_reason + evidence_refs
              - allowed_controller_decisions[]（含可复制 payload，供 sp_start 直接用）
              - recommended_next 仅作辅助提示，不得替代 allowed_controller_decisions
```

### workflow 状态命名约定

| 场景 | 应用状态 | 主控入口 |
|------|---------|---------|
| 派发/运行/通知等技术异常 | `waiting_controller_decision` | `allowed_controller_decisions` → `sp_start(resolve_controller_decision)` |
| 设计稿/计划待用户点头 | `awaiting_design_approval` / `awaiting_plan_approval` | `approve_*` / `revise_*`（现有路径） |
| 子会话向用户提问（正常交互） | `waiting_user` + node `needs_user` | `sp_start(resume_user_input)` |
| 平台权限弹窗（OpenCode 限制） | node 仍 `running`，附 `permission_context` | 主控告知用户切换 child session；**插件不能代批** |

**本计划调整**：原稿中 prompt 失败、session.error、liveness 写的 `waiting_user_decision` 统一改为 `waiting_controller_decision`，与 PRD 矩阵对齐。`waiting_user_decision` 仅保留给历史兼容，新路径不再写入。

### 主控可用的恢复工具（不新增 public tool）

异常恢复只通过现有 5 工具，重点是：

1. **`sp_status`** — 对齐事实、拿 `allowed_controller_decisions`
2. **`sp_start(resolve_controller_decision)`** — 提交 `retry_node` / `continue_existing_graph` / `accept_partial_result` / `mark_blocked` / `request_reprepare` / `apply_workflow_patch` 等
3. **`sp_start(resume_user_input)`** — `needs_user` / `notification_failed` 时恢复问答
4. **`sp_cancel`** — 主控明确放弃整条 workflow
5. **`sp_prepare`** — `request_reprepare` 后的修订任务入口

`recommended_next` 中的 `retry_dispatch` 等 legacy 提示逐步收敛为 `allowed_controller_decisions` 里的 `retry_node` payload，避免主控有两套填参方式。

### 各 Phase 与理念的一致性核对

| 计划项 | 插件行为 | 主控行为 | 一致性 |
|--------|---------|---------|--------|
| 1.1 prompt 失败写 state | 标 `dispatch_failed`/`prompt_delivery_failed`，workflow → `waiting_controller_decision` | 从 decisions 选 `retry_node` 或 `mark_blocked`/`sp_cancel` | ✅ |
| 1.2 session.error 降级 | 按策略标 `interrupted`/`failed`，不自动重派 | 选 retry / accept_partial / cancel | ✅ |
| 1.3 liveness 超时 | 仅标 `interrupted`（事实：长时间无 progress），**不**自动重试 | 同 1.2 | ✅（须禁止 silent auto-retry） |
| 2.1 feedback 统一 | 补齐 decisions + hints，不替主控选 | 一次 `sp_status` 即可裁决 | ✅ |
| 2.2/2.3 notify 失败 | 标 `notification_failed`，保留 `pending_question` | `resume_user_input` 或 `sp_status` 后裁决 | ✅ |
| 3.1 权限等待 | 只暴露 `permission_context`，状态仍 running | 引导用户去 child 点批准 | ✅ |
| 3.3 schema 瘦身 | payload 模板只在 `allowed_controller_decisions` 动态生成 | 照抄 payload 调用 `sp_start` | ✅ |
| 4.x build gate | 校验 checks，失败进 `waiting_controller_decision` | 主控决定 retry / reprepare / accept_partial | ✅ |

### 明确禁止（即使「能自动修好」）

- 插件在 `session.error` / liveness / dispatch 失败后**自动** `dispatch()` 同一 node
- 插件根据错误类型猜测用户想 cancel 还是 retry
- 新增 `sp_decide` 或让主控用 bash/edit 绕过 gate 恢复
- 用 TUI progress 替代 `sp_report` / state 做 transition 依据

### 并行执行：一个失败，其他要不要停？

**默认策略：不全家停。** 与 PRD §12「独立问题域可并行」、哲学文档「dispatching-parallel-agents 只并行独立域」一致。

| 维度 | 插件行为 | 主控行为 |
|------|---------|---------|
| **失败范围** | 只闭合**失败那条分支**的 node（`failed` / `interrupted` / `dispatch_failed` 等）；**不**自动 cancel 其他 child session | 读 `sp_status` 看「谁挂了、谁还在跑」 |
| **仍在跑的 sibling** | 保持 `running`，OpenCode child session **继续执行**；插件不再给失败分支自动派下游 | 可选择：让它们跑完、或 `sp_cancel` 整单/按 task 取消 |
| **新调度** | 失败分支下游因 `depends_on` / `isTaskLevelPassed` 不满足而**暂停**；无依赖的 sibling 在 `passed` 后仍可正常派下一跳（现有并行测试已覆盖） | 失败且无明确 failure edge 时，workflow 进 `waiting_controller_decision`，由主控裁决 retry / partial / cancel |
| **workflow 总状态** | 有 sibling 仍 `running` 时，**不应**把整个 workflow 粗暴标成全局 `failed` 并假装一切终止；应呈现「混合态」：`attention` + `still_running_nodes` + `allowed_controller_decisions` | 结合用户目标决定：只修失败 task、等其他 task 收尾、还是全线取消 |

**当前代码与目标的差距（修复时要补）**

- `sp_report(status="failed")` 会把 workflow 全局标为 `failed`，但 sibling 可能仍在跑 → 主控看到的状态和实际 child 不一致。
- `waiting_controller_decision` 未列入 dispatch 早停列表，与 `failed` 行为不对称。
- `controller_feedback` 缺少 `still_running_nodes` / `failed_nodes` 并列展示，主控不易做并行场景裁决。

**修复计划中的落地（并入 Phase 2.1）**

- 并行异常时：`workflow.status = waiting_controller_decision`（或保持 `running` 但 `attention=parallel_failure`），附 `decision_reason`。
- `sp_status` 返回：`failed_nodes[]`、`running_nodes[]`、`blocked_downstream[]`。
- `allowed_controller_decisions` 至少含：`retry_node`（仅失败 task）、`continue_existing_graph`（等其他 sibling 自然结束）、`mark_blocked`、`sp_cancel` 级 cancel。
- **除非**主控显式 `sp_cancel` 或 `mark_blocked`，插件不主动 kill 其他 running child。

**何时才「全家等主控」**

- 全部 running node 都已闭合（无 sibling 在跑），只剩失败/中断待裁决。
- 启动恢复 `recovered_unknown`：无法确认哪些 child 还活着，必须主控先 inspect 再决定（可能 cancel 全部 retry）。
- 主控已调用 `sp_cancel`（整 workflow 或指定 task/session）。

## 现状结论（规划前提）

- **问题 12（transition 硬编码）**：已在 `workflow-spec-dispatch.ts` 落地，本计划不重复排期。
- **核心债**：观察层（progress/TUI）与决策层（state + `controller_feedback`）脱节。
- **双轨建议**：`sp_status.recommended_next`（workflow-status）比 `controller_feedback.recommended_next`（feedback.ts）更细，主控却主要读后者。

## 总目标

| 维度 | 修复前 | 修复后 |
|------|--------|--------|
| 派发失败 | session 创建失败有 state；prompt 失败只有 toast | 两类失败都写入 state + `waiting_controller_decision` + `allowed_controller_decisions` |
| 运行中异常 | `session.error`/挂死仍 `running` | 降级为 `interrupted`/`failed`，workflow 进入 `waiting_controller_decision` |
| 主控恢复 | `wait_running_node` 误导读；`recovered_unknown` 指引粗 | 统一 feedback：`blocking_reason` + `allowed_controller_decisions`（`retry_node` 等可复制 payload） |
| PRD 缺口 | `notification_failed` 未写入 | notify 失败可审计；主控可用 `resume_user_input` 或 `resolve_controller_decision` 继续 |

## 阶段划分

```text
Phase 1  P0  假活治理（2 → 1 → 3）
Phase 2  P1  恢复指引统一（5 → 4 → 6 → 13 → 7）
Phase 3  P2  体验加固（9 → 10 → 11）
Phase 4  按需  质量闭环（8）
```

建议 **4 个独立 PR / feature 分支**，便于 review 和回滚。

---

## Phase 1：P0 假活治理

### 1.1 Prompt 投递失败写入 state（原问题 2、7）

**目标**：`createNodeSession` 成功但 `continueNodeSession` 失败时，与 `dispatch_failed` 对称。

**改动点**

- `src/session/orchestrator.ts`：`scheduleNodePrompt` catch 中回调 store（通过注入或 orchestrator 持有 store 引用）。
- `src/state/store.ts`：新增 `markPromptDeliveryFailed({ node_id, session_id, error })` 或复用 `markDispatchFailed` 的「更新已有 running node」变体。
  - node：`running` → `prompt_delivery_failed`（新状态）或复用 `dispatch_failed` + event 区分阶段。
  - workflow：`waiting_controller_decision`（附 `decision_reason` / `evidence_refs`）。
- `src/controller/feedback.ts`：`prompt_delivery_failed` / `dispatch_failed` 纳入 `buildAllowedControllerDecisions`，输出 `retry_node` + `mark_blocked`；`recommended_next` 与之对齐。
- `src/state/types.ts`：若新增 `prompt_delivery_failed`，同步 TUI / status 枚举。

**验收**

- 集成测试：mock `continueNodeSession` 抛错 → state 非 `running`；workflow 为 `waiting_controller_decision`；`sp_status.allowed_controller_decisions` 含 `retry_node` 且 payload 可直接用于 `sp_start(resolve_controller_decision)`。
- 插件**不**在 catch 里自动重试 dispatch。

**估时**：0.5–1 天

---

### 1.2 `session.error` 降级 state（原问题 1）

**目标**：provider 超时/API 错误时，不把 node 留在假 `running`。

**改动点**

- `src/plugin.ts` event hook：除 `waiting_permission` 外，识别 `session.error`（及必要时的 `session.idle` 组合，见 1.3）。
- 根据 `session_id` 找 `node_runs`；按错误类型映射：
  - 明确不可恢复（401、model not found）→ `failed`
  - 超时/rate limit → 可配置 `interrupted` 或 `failed`
  - 未知 → `interrupted`
- workflow：统一为 `waiting_controller_decision`（记录 `decision_reason`：session_error / liveness 等）。
- `controller/feedback.ts`：`buildAllowedControllerDecisions` 附 `retry_node` / `accept_partial_result` / `mark_blocked` 模板（带 `node_id`、`task_id`）；**不**自动 dispatch。
- 保留 `late_report_ignored`，避免迟到 report 覆盖。

**配置**（`superpowers-controller.jsonc` 可选）

```jsonc
{
  "session_error_policy": {
    "default": "interrupted",
    "non_retryable_patterns": ["401", "model_not_found"]
  }
}
```

**验收**

- 单测：模拟 event → node 状态变更 + history/event 审计。
- 手工：child 报错后 `sp_status` 不再建议 `wait_running_node`；`allowed_controller_decisions` 非空。

**估时**：1 天

**依赖**：建议在 1.1 之后，复用同一套 feedback 结构。

---

### 1.3 可选 liveness 超时（原问题 3，中期）

**目标**：无 `session.error`、无 terminal report 时，不依赖重启才发现挂死。

**改动点**

- 新模块 `src/runtime/liveness.ts` 或在 plugin startup 注册定时检查（仅 active workflow + `running` node）。
- 阈值默认 60s（可配置），基于 `progress.jsonl` 最后事件时间；超时 → node `interrupted` + workflow `waiting_controller_decision`（**仅记事实，不自动 retry**）。
- 与 TUI `STALLED_PROGRESS_AFTER_MS`（30s）对齐或文档说明差异：TUI 早提示，runtime 晚降级；降级后主控须显式 `resolve_controller_decision`。

**验收**

- 测试：伪造 `running` + 陈旧 progress → 自动 `interrupted`。
- 不误伤慢速但仍有 progress 的 node。

**估时**：1–1.5 天

**依赖**：1.2 完成后再做，避免两套机制打架。

---

## Phase 2：P1 恢复指引统一

### 2.1 统一 `controller_feedback` 与 workflow-status（原问题 4、5）

**目标**：主控只读 `controller_feedback` 也能拿到 stalled / recovered / permission 场景下的 **`allowed_controller_decisions`**（`recommended_next` 与之同步，不作第二套协议）。

**改动点**

- `src/controller/feedback.ts`：`buildRecommendedNext` 重构为 **委托或合并** `workflow-status.ts` 的 `recommendedNext()` 逻辑（或抽 `src/runtime/recovery-hints.ts` 共享）；**以 `buildAllowedControllerDecisions` 为权威输出**。
- 优先级与 workflow-status 对齐：
  1. `dispatch_failed` / `prompt_delivery_failed`
  2. `interrupted` / `recovered_unknown`
  3. `waiting_controller_decision`
  4. **`stalled`（running + 无 progress ≥ 阈值）**
  5. `waiting_permission`
  6. 普通 `running` → `wait_running_node`
- 新增可选字段（不破坏现有 consumers）：

```ts
type ControllerFeedback = {
  // ...
  parallel_context?: {
    failed_nodes: Array<{ node_id, task_id, session_id, status }>
    running_nodes: Array<{ node_id, task_id, session_id }>
    blocked_downstream: string[]  // 因依赖失败而暂不可派的 node/task
  }
  inspection_hints?: Array<{
    tool: "sp_status"
    args: Record<string, unknown>
    reason: string
  }>
  stall_context?: { node_id, session_id, idle_ms }
  permission_context?: { session_id, hint: string }
}
```

- `sp_status`：继续返回双字段，但两者语义一致；文档注明 `controller_feedback` 为权威。

**验收**

- 测试矩阵：三种卡住形态各有一条明确 `allowed_controller_decisions`（含 `retry_node` payload），`recommended_next` 不再单独指向 `retry_dispatch`。
- `recovered_unknown` + interrupted 列表 → decisions 含 `retry_node` + `mark_blocked` + inspection hint。

**估时**：1–1.5 天

**依赖**：Phase 1 状态枚举稳定后做。

---

### 2.2 `notification_failed` 接线（原问题 6）

**目标**：`notifyParent` 失败可审计，TUI 分支可触发。

**改动点**

- `src/tools/report-handler.ts`：`needs_user` 路径 notify 失败 → 对应 node `notification_failed`（保留 `pending_question`，workflow 仍 `waiting_user`）。
- `src/controller/feedback.ts`：`waiting_user` + `pending_question` 时始终输出问题全文；建议 `answer_pending_question` → `sp_start(resume_input)`。
- 可选低优：后台重试 notify 一次。

**验收**

- 测试：mock `notifyParent` 失败 → node status + `sp_status` 可见问题。

**估时**：0.5 天

---

### 2.3 Controller decision 通知失败加固（原问题 13）

**目标**：notify 失败时主控仍能裁决。

**改动点**

- `report-handler.ts`：`waiting_controller_decision` notify 失败时：
  - `blocking_reason` 写明需主动 `sp_status`
  - `controller_feedback.allowed_controller_decisions` 已在返回值中（确保 `sp_report` 响应体完整）
  - history：`controller_decision_notification_failed`
- 与 2.2 共用 notify 失败处理 helper。

**估时**：0.5 天（可与 2.2 同 PR）

---

## Phase 3：P2 体验加固

### 3.1 权限等待可见性（原问题 9）

- `controller_feedback.permission_context`：「请切换到 child session {id} 批准权限」。
- 主控 agent prompt 补一句规则（`src/agents/index.ts`）。

**估时**：0.25 天

---

### 3.2 Gate 阻断文案（原问题 10）

- `src/router/gates.ts`：主控 mutating 阻断附「请用 sp_prepare → sp_start 派 node」。
- 可选：`recommended_next: request_reprepare` 写入 tool execute 异常外的 feedback（若 host 支持）。

**估时**：0.25 天

---

### 3.3 `sp_start` schema 瘦身（原问题 11）

- `sp_start` description 只保留 action 枚举 + 必填字段。
- 完整 payload 模板只在 `allowed_controller_decisions[].payload` 和 `staleStateFeedback` 中动态生成。
- 观察一轮 E2E 填参错误率。

**估时**：0.5 天

---

## Phase 4：按需 — Build/Test 质量门禁（原问题 8）

**仅在团队明确要求时排期。**

- `workflow-spec` / `StartConfig` 增加 `required_checks?: ("build"|"test"|"lint")[]`。
- verifier/finisher `sp_report.checks` 契约；finish transition 校验。
- 三级：`off` / `guided` / `strict`，与现有 gate 风格一致。

**估时**：2–3 天（含模板与测试）

---

## PR 拆分建议

| PR | 内容 | 风险 |
|----|------|------|
| PR-1 | 1.1 prompt 失败写 state | 低 |
| PR-2 | 1.2 session.error 降级 | 中（需摸清 OpenCode event 形状） |
| PR-3 | 2.1 feedback 统一 + inspection_hints | 中 |
| PR-4 | 2.2 + 2.3 notification 失败 | 低 |
| PR-5 | 1.3 liveness（可选） | 中 |
| PR-6 | 3.1–3.3 体验 | 低 |
| PR-7 | 4.x build gate（可选） | 中 |

## 测试策略

每个 PR 至少包含：

1. **单元测试**：store 状态迁移、feedback 输出。
2. **集成测试**：`report-handler` / `sp_start` + mock orchestrator / mock event。
3. **回归**：现有 `sp-record-dispatch`、`controller-intake`、`workflow-spec-dispatch` 全绿。
4. **手工**：provider 断线、权限等待、重启恢复各走一遍。

## 文档更新

每 PR 合并后更新：

- `docs/modules/controller.md` — feedback 契约
- `docs/modules/state.md` — 新 node status / 迁移
- `docs/modules/progress.md` — error / stalled / liveness 边界
- `docs/analysis/2026-07-10-plugin-runtime-risk-and-tool-gap.md` — 问题 12 标已解决；已修项打勾

## 建议落地顺序（时间线）

```text
Week 1
  PR-1 prompt 失败
  PR-2 session.error
  PR-3 feedback 统一

Week 2
  PR-4 notification 失败
  PR-5 liveness（若 Week 1 稳定）
  PR-6 体验小改

按需
  PR-7 build gate
```

## 明确不做

- 不新增 public tool（`sp_decide` 等）。
- 不让主控直接 edit/bash 绕过 gate。
- 不绕过 OpenCode 权限系统自动批准。
- 不重写 spec-driven dispatch（问题 12 已完成）。

## 完成定义（整体）

1. 派发失败、session 错误、挂死三类场景，**durable state 与 progress 一致**，workflow 进入 `waiting_controller_decision`（或 PRD 规定的其他决策态）。
2. 主控仅凭 `sp_status` 的 `allowed_controller_decisions` 即可调用 `sp_start(resolve_controller_decision)` 推进；`controller_feedback` 能区分 stalled / permission / recovered / dispatch 失败。
3. 插件在异常路径**从不**自动 retry/cancel；`notification_failed` 在 notify 失败路径可触发。
4. 全量测试 + `bun run build` 通过。
