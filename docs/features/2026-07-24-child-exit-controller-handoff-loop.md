# Feature: 子会话停止与主控接手闭环

## 日期

2026-07-24

## 背景

最新 run（`20dd0d90-…`）出现：`012-implement-T4-retry-2` 已 `session_idle` 闭合，但 sibling `007-implement-T1` 仍 durable `running`，workflow 保持 `running` / `unreported-idle`。`notifyParentControllerDecision` 因 status ≠ `waiting_controller_decision` 直接退出 → **不切回主控、不叫醒主控**。用户一直「等子会话」，子会话其实已停。

另有叠加洞：
1. `healInterruptedBusySessions` 可把 `waiting_controller_decision` 救回 `running`
2. `tool_running` 永久豁免 liveness，进程死后 progress 停在 running 会永远不超时

## 目标

子节点异常结束时，无论是否还有 sibling running，都要：**闭合 → 切回主控 → 通知主控**；假 running 能被回收。

## 行为

1. **silent-exit / unreported-exit**  
   - 标记节点后 **始终** `returnToParent` + toast  
   - 若进入 `waiting_controller_decision`：走既有 controller decision prompt  
   - 若因 sibling 仍 `running` 保持 workflow `running`：仍向主控投递「某节点异常、其它仍在跑」attention prompt  

2. **heal**  
   - workflow 已是 `waiting_controller_decision` 时 **禁止** heal 回 `running`  
   - 仅当 interrupted 节点近期仍有 progress（如 2 分钟内）才允许 heal  

3. **liveness in-flight**  
   - progress 中若在工具之后出现 `session_idle` / `session_error` → 不再视为 in-flight  
   - in-flight 豁免最长 **45 分钟**（自最近 `tool_running`/`pending` 起算），超时后按普通空闲判定  

4. **`sp_start` empty_dispatch**  
   - `markNeedsControllerDecision` 后调用 `notifyParentControllerDecision`（含切回主控）

## 非目标

- 不改 design 前台直聊策略  
- 不在本次重做并行调度语义（sibling 仍可继续跑）

## 验收

1. silent-exit 有 sibling running 时也会 `returnToParent` + notify  
2. heal 不会把 `waiting_controller_decision` 改回 `running`  
3. `tool_running` + 随后 `session_idle` 可被 liveness 回收；超 45 分钟的卡死 tool_running 可超时  
4. empty_dispatch 会通知主控  
5. build + install:local 通过  

## 相关文件

- `src/runtime/unreported-exit-handler.ts`
- `src/runtime/notify-controller.ts`
- `src/runtime/liveness.ts`
- `src/session/templates.ts`
- `src/state/store.ts`
- `src/tui.ts`
- `src/tools/sp-start.ts`
- `test/silent-exit.test.ts` / `test/liveness.test.ts` / heal 相关测试
- `docs/modules/state.md` / `session-orchestrator.md` / `progress.md`
