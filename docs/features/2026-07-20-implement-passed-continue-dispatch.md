# Implement Passed Continue Dispatch

## 背景

`sp_report(implementation, passed)` 后，runtime 本应按 workflow-spec 自动派发下一步，不需要主会话 intervening。

实际在「code-review failed → implement retry → implement passed」路径上会算出空 `decisions`：直接后继 `acceptance` 因历史 `passed` 被当成 terminal 滤掉，同时又不会回落到「找下一个 runnable / finish」。流水线静默停在 `implementation-complete`。

同理，若检查链已全部 passed，implement 再次通过时也应判定当前任务完成并进入下一任务或 finish，而不是停住。

## 目标

1. `implementation` + `passed` 后，若同 scope 检查链（acceptance → verification → code-review）存在 latest `failed` / `blocked` / `needs_user`，强制从 acceptance 重派（忽略历史 passed terminal）。
2. 若检查链全部已 passed（或无检查链），回落到 `decideRunnableFromSpec`：下一 task 的 implement、或 finisher、或 finish decision。
3. 任意 `passed` report 在边目标被滤空且 workflow 未完成时，回落 runnable 计算，避免空数组静默停摆。
4. 不改变「自动派发、不先回主会话」的契约；主会话仍只处理 `needs_user` / controller decision / `recovered_unknown`。

## 非目标

- 不改 public tool surface。
- 不在本次清掉历史 node_runs；重派会追加新的 acceptance 等 node run。
- 不在本次专门做 startup reconcile / busy 跨进程修复。

## 方案

改动点：`src/router/workflow-spec-dispatch.ts` 的 `decideFromWorkflowSpec`。

在边目标 `decisions` 为空时：

1. 仍先处理 `isWorkflowComplete` → `finish`。
2. 对 `implementation` + `passed` 调用 `continueAfterImplementPassed`：
   - 从 implement 节点沿 passed 边（或 `depends_on`）收集 check chain。
   - 有失败态检查 → `decisionForSpecNode(acceptance)`（绕过 terminal 过滤）。
   - 有未完成检查（interrupted / 未跑等）→ 派发第一个未 passed 的检查节点。
   - 否则 → `decideRunnableFromSpec`。
3. 其他 `passed` report 同样回落 `decideRunnableFromSpec`。

## 验收

- 单元测试：CR failed → implement passed → 派发 acceptance。
- 单元测试：implement passed 且 acceptance/verification/code-review 均 passed → 派发下一 task implement 或 finish。
- 单元测试：正常首次 implement passed（检查链未跑）→ 仍派发 acceptance（回归）。
- `bun test` 相关套件通过；`bun run build` 通过。

## 模块文档

更新 `docs/modules/controller.md` 中 transition / check-failure 相关说明。
