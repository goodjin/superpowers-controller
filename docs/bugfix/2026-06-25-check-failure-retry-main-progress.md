# Bug Fix: Check Failure Retry And Main Progress

## 问题描述

- 日期: 2026-06-25
- 严重程度: High
- 影响范围: Feature/debug/review workflow 的检查失败恢复，以及主会话 TUI 进度展示

检查环节失败后，runtime 会计算 retry dispatch，但 workflow state 仍停留在 `failed`。用户界面因此看起来像流程卡住了，即使 implementer retry 已经被派发。

同时，TUI 没有注册主会话 prompt 附近的 `session_prompt_right`，主会话区域看不到 Superpowers workflow 的运行信息，只能依赖 sidebar 或 progress route。

## 根因分析

- 问题位置:
  - `src/state/store.ts`
  - `src/tui.ts`
- 原因:
  - `recordNodeResult()` 把 failed check 应用到 workflow 后，`statusForRecord()` 会把 workflow 设为 `failed`。
  - 后续 `addNodeRun()` 只追加 retry node run，不恢复 workflow `status/current_phase`。
  - TUI resident slot 列表没有包含 `session_prompt_right`。

## 修复方案

- `addNodeRun()` 在新增 node run 时，如果 workflow 不是 `passed` 或 `canceled`，恢复为 `running`，并把 `phase/current_phase` 更新为新 node phase。
- 注册 `session_prompt_right` resident slot，使用 compact progress renderer。
- 保持 `home_prompt` 和 `home_prompt_right` 不注册；它们属于首页区域，不是主会话运行态展示入口。
- 增加测试覆盖 failed acceptance 回派 implementer、workflow 恢复 running、retry prompt 携带失败上下文，以及 home prompt slots 注册。

## 验证步骤

1. 运行 targeted tests：
   - `bun test ./test/store-node-runs.test.ts ./test/sp-record-dispatch.test.ts ./test/tui-plugin.test.ts ./test/progress-panel.test.ts`
2. 运行完整测试。
3. 运行 build。

## 相关测试

- `test/sp-record-dispatch.test.ts`
- `test/store-node-runs.test.ts`
- `test/tui-plugin.test.ts`
- `test/progress-panel.test.ts`

## 设计建议

后续可以把 task/check state 从 `node_runs` 中拆出来。这样 UI 可以直接展示每个 task 的 implementation、acceptance、verification、code review 细分状态，而不是从 node_runs 推导。
