# Bug Fix: Check Failure Retry And Main Progress

## 问题描述

- 日期: 2026-06-25
- 严重程度: High
- 影响范围: Feature/debug/review workflow 的检查失败恢复，以及主会话 TUI 进度展示

检查环节失败后，runtime 会计算 retry dispatch，但 workflow state 仍停留在 `failed`。用户界面因此看起来像流程卡住了，即使 implementer retry 已经被派发。

同时，workflow 会话运行信息需要集中展示在 `sidebar_content`，不能放在 prompt/right 或首页区域。

## 根因分析

- 问题位置:
  - `src/state/store.ts`
  - `src/tui.ts`
- 原因:
  - `recordNodeResult()` 把 failed check 应用到 workflow 后，`statusForRecord()` 会把 workflow 设为 `failed`。
  - 后续 `addNodeRun()` 只追加 retry node run，不恢复 workflow `status/current_phase`。
  - TUI resident slot 分工没有明确 `sidebar_content` 是 workflow 会话运行信息主展示区域。

## 修复方案

- `addNodeRun()` 在新增 node run 时，如果 workflow 不是 `passed` 或 `canceled`，恢复为 `running`，并把 `phase/current_phase` 更新为新 node phase。
- 保持 `sidebar_content` resident slot，展示 workflow 总览、运行中 child session 和 pending question。
- 保持 `session_prompt_right`、`home_prompt` 和 `home_prompt_right` 不注册；prompt/right 与首页区域不作为 workflow 会话运行态展示入口。
- 增加测试覆盖 failed acceptance 回派 implementer、workflow 恢复 running、retry prompt 携带失败上下文，以及 prompt/home slots 不注册约束。

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
