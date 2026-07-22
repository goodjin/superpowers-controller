# Feature: Design 阶段前台子会话交互

## 日期

2026-07-22

## 目标

design 阶段减少「主控转述」成本：TUI 自动进入 `sp-designer` 子会话，用户直接在子会话里回答澄清与候选稿反馈；真正离开 design 后再自动切回主控，并在切换时 toast 提示。

## 行为

1. **进入 design**  
   `dispatch` 创建/复用 `phase=design` 子会话后：`selectSession(child)` + toast「已进入 design 子会话，可直接对话」。  
   `sp-designer` 创建时**不传** OpenCode `parentID`，使用普通可交互 session 壳（保留底部输入框）。逻辑父子仍写在 workflow state。

2. **澄清提问（`needs_user`，source 为 design）**  
   通知投到 design 子会话（`sp-designer` + foreground 文案），`selectSession(child)`。  
   用户在子会话回答 → 现有 `child-answer-bridge` 消费 `pending_question`。  
   plan / 其他 phase 仍走主控单入口（不变）。

3. **候选稿审批（`awaiting_design_approval`）**  
   design 尚未结束：留在 / 切到 design 子会话，向 designer 投短提示，请用户在子会话选择同意或继续修改。  
   - 修改：继续留在子会话对话，designer 可再次 `sp_report`。  
   - 明确同意：再 `selectSession(parent)` + 通知主控带着用户意向走 `start_prepared_task` / 确认路径（designer 不执行 `sp_start`）。

4. **离开 design**  
   design `passed` 后若派发非 design 节点（如 plan），或用户同意后的主控交接：`selectSession(parent)` + toast「design 已结束，已切回主控」。

## 非目标

- 不把 plan 改成自动前台（本次仅 design）。
- 不恢复全局 legacy/hybrid；这是 native 下的 design 特例。
- 不让 `sp-designer` 直接调用 `sp_start` 完成启动确认。

## 验收

1. design 派发后 TUI 选中 designer 子会话，并有进入提示。
2. design `needs_user` 通知目标为 designer 子会话，不在主控追问；子会话作答可 bridge。
3. `awaiting_design_approval` 不抢切主控；同意后才切回主控并由主控收尾。
4. design 结束后进入下一阶段时切回主控，并有离开提示。
5. plan 的 needs_user / approval 仍通知主控。
6. 相关单测更新并通过；编译打包通过。

## 相关文件

- `src/session/orchestrator.ts`
- `src/session/design-foreground.ts`（新建）
- `src/session/templates.ts`
- `src/tools/report-handler.ts`
- `src/runtime/child-answer-bridge.ts`
- `src/plugin.ts`
- `src/agents/index.ts`
- `docs/modules/session-orchestrator.md`
