# Feature: 子会话无 sp_report 结束时回主控

## 日期

2026-07-14

## 目标

子会话结束（`session.idle`）或被 liveness / session.error 闭合时，如果节点仍是 `running`（从未 `sp_report`），runtime 应：

1. 采集最后一段助手文字
2. 扫产出文件路径（工具入参、patch 详情、progress）
3. 落盘证据并进入 `waiting_controller_decision`
4. `notifyParent` 叫醒主控，由主控选择 retry / cancel / reprepare 等

**不**把静默结束当成 `passed` 自动往下走。

## 触发

| 来源 | 条件 |
|------|------|
| `session.idle` | 匹配 `node_runs` 且 `status === "running"` |
| liveness timeout | 同上（兜底） |
| `session.error` | 同上，额外带 error 信息 |

`needs_user` / `passed` / 已闭合节点忽略。

## 证据

写入 `nodes/<node-id>/silent-exit.md` 与 `silent-exit.json`，并登记 `fallback_summaries`：

- `assistant_text`：最后一段非控制器注入的助手正文
- `produced_paths`：去重后的产出路径列表
- `reason`：`session_idle` | `liveness_timeout` | `session_error`

## 主控通知

与 `sp_report` 后进入 `waiting_controller_decision` 相同：调度 parent prompt，附证据摘要与 `allowed_controller_decisions` 指引。

## 验收

1. 子会话 idle 且无 `sp_report` → state 为 `waiting_controller_decision`，silent-exit 文件存在
2. 主控收到含助手摘要与产出路径的通知
3. `needs_user` 后的 idle 不误触发
4. 单测覆盖采集与 store 闭合

## 相关文件

- `src/runtime/silent-exit.ts`
- `src/runtime/notify-controller.ts`
- `src/state/store.ts`
- `src/plugin.ts`
- `src/session/templates.ts`
- `test/silent-exit.test.ts`
