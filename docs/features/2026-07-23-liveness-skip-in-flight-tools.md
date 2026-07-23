# Feature: 进行中的 tool_running 不触发 liveness 超时

## 日期

2026-07-23

## 目标

长命令（如 `brew install`）在 `tool_running` 期间可能长时间没有新的 progress 事件。当前 liveness 只看「最后一条 progress 时间」，会把仍在执行的工具误判为空闲并 `liveness_timeout`。

## 行为

对每个 `running` 节点，从 `progress.jsonl` **从后往前**找最近的工具生命周期事件：

- 最近是 `tool_running` 或 `tool_pending` → **不计入超时**（视为工具仍在执行）
- 最近是 `tool_completed` 或 `tool_error` → 按原逻辑用最后一条 progress 时间判断空闲
- 没有任何 tool_* 事件 → 按原逻辑

其它非 tool 事件（`text` / `reasoning` / `session_status` 等）在扫描时跳过，不影响「是否 in-flight」判断。

默认超时仍为 5 分钟；仅增加 in-flight 豁免。

## 非目标

- 不引入「工具卡住」的第二套超长超时（卡住可靠 `session_idle` / 人工 cancel）
- 不改 silent-exit / 回切主控逻辑

## 验收

1. 单测：最后工具态为 `tool_running` 时，即使超过 timeout 也不过期
2. 单测：`tool_completed` 后长时间无进度仍过期
3. build + install:local 通过

## 相关文件

- `src/runtime/liveness.ts`
- `test/liveness.test.ts`
- `docs/modules/session-orchestrator.md`（或 progress 相关说明）
