# Feature: 主控接手时自动切回主控会话

## 日期

2026-07-23

## 目标

保留 design 阶段自动进入 designer 子会话；当子会话异常结束、或 workflow 进入需要主控裁决/已取消等状态时，TUI **自动切回主控**并 toast 提示，避免用户停在空白子会话页看不到主控反应。

## 行为

1. **仍自动切入**：仅 design 派发后（既有逻辑不变）。
2. **必须自动切回主控 + toast**（文案示例：「子会话需要主控接手，已切回主控。」）：
   - `liveness_timeout` / `session_idle` / `session_error` 导致的 silent-exit → `waiting_controller_decision`
   - 其它进入 `waiting_controller_decision` 的路径（如 empty_dispatch）
   - workflow `canceled` / `blocked` / `failed`（若当前可能停在子会话）
3. `notifyParent` 的 `selectSession` 保留；再显式走 `returnToParent`，确保有中文 toast，且 notify 失败时仍尽量切回。

## 非目标

- 不取消 design 前台直聊。
- 不把 implement/plan 改成自动切入。
- 不改 liveness 超时阈值本身。

## 验收

1. 模拟/单测：unreported exit 后会 `selectSession(parent)` 并有切回 toast。
2. `waiting_controller_decision` 通知主控时同样切回。
3. `sp_cancel` 后切回主控。
4. design 派发仍自动进子会话。
5. build + install:local 通过。

## 相关文件

- `src/runtime/notify-controller.ts`
- `src/runtime/unreported-exit-handler.ts`
- `src/session/orchestrator.ts`
- `src/tools/report-handler.ts`
- `src/tools/sp-cancel.ts`
- `src/tools/index.ts`
- `src/plugin.ts`
- `docs/modules/session-orchestrator.md`
