# Sidebar Visible Node Runs Only

## 背景

右侧 workflow 列表直接渲染整份 `node_runs`。同一 phase 多次 retry（liveness_timeout / cancel）后，侧栏会堆满 `interrupted` 旧行，和当前 running / 最新 passed 混在一起，难扫读。

`sp_prepare` 会新建 run，不会改旧 run；问题出在**同一次 run 内**的历史 attempt 全量展示。

## 目标

侧栏 / progress panel 的 child 列表只显示「完成任务当前仍需要看见」的节点：

1. 按 `task_id + phase`（无 `task_id` 时按 `phase`）分组，每组只保留**最新**一条。
2. 因此被更新尝试替代的 `interrupted` / `canceled` / `dispatch_failed` 等旧行不再出现。
3. 仍显示该组最新的 `running` / `passed` / `failed` / `needs_user` / `blocked` 等。
4. **不删**磁盘上的 `node_runs` 历史；只改展示过滤。

## 非目标

- 不改 transition / retry / late report 逻辑。
- 不在 prepare/start 时物理 prune `node_runs`。
- 不改 host 侧「会话是否属于本 workflow」的匹配（仍可用全部 session id）。

## 方案

- 在 `src/tui/progress-panel.ts` 增加 `visibleNodeRunsForDisplay()`，`buildProgressPanelViewModel` 建 rows 前先过滤。
- 单元测试覆盖：同 phase 旧 interrupted + 新 running 只显示新；不同 phase 各自保留最新。
- 更新 `docs/modules/progress.md` 侧栏说明。

## 验收

- 侧栏不再同时列出同 phase 的旧 interrupted 与新 attempt。
- 既有 progress-panel 测试通过；新增过滤测试通过。
- `bun run build` 与本地安装完成。
