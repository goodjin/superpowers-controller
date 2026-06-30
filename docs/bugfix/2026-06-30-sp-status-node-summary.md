# Bug Fix: sp_status Node Summary Completeness

## 问题描述

- 日期: 2026-06-30
- 严重程度: Medium
- 影响范围: `sp_status` 工具返回契约、controller prompt

用户观察到 controller 调用 `sp_status(include_progress=true)` 后，仍然说要用 `grep` 查看完整节点列表的关键状态。说明工具结果虽然包含 runtime state，但没有给模型一个足够直接的节点状态摘要。

## 根因分析

当前 `sp_status(include_progress=true)` 的默认 `detail` 是 `summary`：

- 会返回 `summary`、`current` 和 `progress_digest`。
- `progress_digest` 适合回答“最近在干什么”，但不是完整节点状态表。
- 完整 session 列表只有在 `detail="sessions"` 或 `detail="full"` 时才返回。
- `current.node_runs` 虽然包含原始节点列表，但字段多、需要模型自行聚合“最后阶段、未完成节点、是否还有 running/interrupted/blocked”。模型容易转而读取落盘 state 或用 grep 辅助判断。

## 修复方案

- 在 `sp_status` 快照里始终返回轻量 `node_summary`。
- `node_summary` 包含：
  - `counts`：节点总数和各状态计数。
  - `last_node`：最后一个 node run。
  - `unfinished_nodes`：running / interrupted / blocked / failed / needs_user / dispatch_failed / notification_failed 节点。
  - `running_nodes`、`blocked_nodes`、`interrupted_nodes`。
  - `latest_by_task`：每个 task 的最新节点状态。
  - `detail_hint`：需要完整进度尾巴时可调用 `sp_status(detail="sessions" 或 "full", include_progress=true)`。
- 更新 controller prompt：温和提示需要完整节点/session 状态时可传 `detail="sessions"` 或 `detail="full"`，不写成强制禁止其它工具。

## 验证步骤

1. 单元测试断言 `sp_status(include_progress=true)` 默认返回 `node_summary`。
2. 单元测试断言 controller prompt 包含温和的 `detail=sessions/full` 参数提示。
3. 运行全量测试、构建、打包和本地 runtime 部署。
