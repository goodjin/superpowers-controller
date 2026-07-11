# Feature: Native-Aligned Subagent Interaction

## 背景

当前 Superpowers 为规避 OpenCode 原生 `parentID` child route 的输入框/sidebar 问题，把 node session 建成**普通顶层 session**，并靠插件主动 `selectSession(child)`、`session_prompt` 代理输入、`app_bottom` 伪 task 条来补交互。

原生 OpenCode subagent 则是另一套模型：

- `session.create({ parentID })` 建立父子树
- 用户**默认留在 parent**，看 Task 卡片（主控调 Task 工具时）或消息流更新
- **权限 / Question 汇总到 parent 底部**，不必先进 child
- 需要细节时用 `Ctrl+Down / Up / Left / Right` 或点卡片进 child

用户希望：**插件只管流程控制与持久化，交互尽量走 host 原生能力**。

## 目标

1. 恢复 OpenCode 父子 session 树，让 permission / question 能在 **parent 路由**处理。
2. dispatch / resume 后**默认留在 parent**，不再自动抢焦点到 child。
3. TUI 插件退化为 **workflow 摘要层**（sidebar + 轻量状态），不替代 host 的 permission / 导航 / 输入。
4. **不改变** runtime 正确性：`sp_start` → `node_runs` 登记 → `session.prompt(child)` → `sp_report`；禁止 agent 调原生 `task`。

## 非目标

- 不让 `superpowers-agent` 或 `sp-*` 调 OpenCode `task` 工具生成 transcript 卡片。
- 不伪造 message part 注入 parent 消息流（无稳定公开 API，且污染审计）。
- 不把 `needs_user` 全面改成 OpenCode `question` 工具（破坏 controller 契约）。
- 不在本 feature 内重做完整 PRD v5 全文，只同步 TUI 交互章节。

---

## 设计原则：插件 vs Host 分工

| 职责 | Host（OpenCode 原生） | 插件（Superpowers） |
|------|----------------------|---------------------|
| 父子 session 树 | `parentID` | 逻辑关系仍写 `node_runs` + `parent_session_id` |
| 权限确认 | parent 底部 Permission UI | 仅记录 progress；**不再** `selectSession` 抢焦点 |
| Question 工具 | parent 底部 Question UI | node agent **仍禁止** `question`；不走这条 |
| 进 child 看细节 | Task 卡片 / `session_child_*` 导航 | 可选：命令面板「打开 node session」 |
| Workflow 状态机 | — | `sp_start` / `sp_report` / store |
| 并行 task 列表 | TodoWrite（child 自发） | sidebar 从 `node_runs` + `task_graph` 汇总 |
| 子会话进度摘要 | child transcript | sidebar + `progress.jsonl`（补充，不替代 transcript） |

---

## 目标交互（Native-Aligned Mode）

### 默认视图：Parent

```
┌─ Parent transcript ─────────────────────┬─ sidebar_content ─┐
│  （无 Task 卡片；可有 controller 消息）   │  workflow 摘要    │
│                                        │  child 列表+状态  │
├────────────────────────────────────────┤                  │
│  [原生] Permission / Question（如有）    │                  │
│  [原生] Parent Prompt                   │                  │
└────────────────────────────────────────┴──────────────────┘
```

- dispatch 后用户仍停在 parent。
- child 要 bash/edit 授权时，**parent 底部弹出 Permission**（OpenCode 汇总子孙 session）。
- 用户用 **`Ctrl+Down`** 进入 child 看完整 transcript；child 底部为 **SubagentFooter**。

### 与原生仍有的差距（须主动补齐，不能「接受就算了」）

| 原生有 | 仅 sidebar + `Ctrl+Down` | 问题 |
|--------|--------------------------|------|
| Transcript 里 **Task 卡片**，状态实时更新 | sidebar 静态列表 + 手动进 child | **主列看不到子会话正在跑什么**，体验断层 |
| 点卡片进 child | 记快捷键 | 可学，但不能替代「扫一眼就知道在跑」 |
| Question 工具 | `sp_report(needs_user)` | 契约不同，另案处理 |

**结论**：`parentID` 解决的是权限/导航；**运行过程可见性**要单独设计，不能靠 sidebar 清单凑合。

### 运行过程可见性：两档补齐方案（推荐 B + 调研 A）

**档 A — Plugin 代注册 Task 展示（最接近原生，需调研）**

- 禁止的是 **agent 调 `task` 工具**，不是 host 永远不能出现 task 卡片。
- 原生卡片依赖 parent 消息里的 `tool` part + `metadata.sessionId`（见 OpenCode `tool/task.ts`）。
- dispatch 完成、`node_runs` 已登记后，由 **orchestrator/server** 尝试写入 parent 侧 task 展示元数据（或调用 host 内部等价 API），把 `child session id` 绑到 parent transcript。
- 若 OpenCode 无稳定 server API → 向 upstream 提「plugin 注册 subagent 展示」能力；在此之前走档 B。

**档 B — 主列 Live Activity 条（不嵌入 transcript，但可扫读）**

- 保留并加强 `app_bottom` 多行面板（非降级）：每行 = 一个 running child，带 **最新 tool/progress 摘要**（1s 刷新），行尾状态 `running / waiting permission / stalled`。
- `sidebar_content` 补 **foreground child 最近 2–4 条 transcript**（已有 `renderForegroundChildTranscript`）。
- 可选：行可点击 / `Ctrl+Down` 等价导航进 child。
- 信息密度接近 task 卡片 footer，位置在 transcript 下方而非消息流内。

**不推荐**：只靠 sidebar 列表 + `Ctrl+Down`，用户默认看不见运行过程。

---

## 核心改动

### 1. Session 创建：恢复 `parentID`

`src/session/adapter.ts`：

```ts
session.create({
  body: {
    parentID: input.parentSessionID,
    title: input.title,
    agent: input.agent,
  },
})
```

- **双写**：OpenCode 树 + `WorkflowState.node_runs`（正确性仍以 store 为准）。
- **特性开关**：`interaction.native_subagent`（`opencode.json` plugin config 或 env），默认 `false` 直至 1.16.2+ 实测通过再改默认。
- **回退**：`false` 时保持现有「无 parentID + 自动切 child」。

**必做验证**（当年 bugfix 的回归门禁）：

- design/plan child running 时，parent 上 permission 能弹出且可点 Allow。
- child route 内 SubagentFooter 可返回 parent。
- parent 上 sidebar slot 仍渲染（此前 bug：child route 丢 sidebar）。

### 2. 焦点策略：默认不抢 child

`src/session/orchestrator.ts`：

| 事件 | 现行为 | 新行为（native mode） |
|------|--------|----------------------|
| dispatch create/reuse | `selectSession(child)` | **不调用** |
| resumeNode | `selectSession(child)` | **不调用** |
| waiting_permission event | `selectSession(child)` | **不调用**（parent 汇总） |

保留：

- toast / progress 记录（可选弱化文案）
- 命令面板 / keymap：**用户主动**「打开 child session」

删除或降级：

- dispatch 后强制切 child 的产品假设（哲学文档 §5.6.1 需改）

### 3. `session_prompt` 代理策略

Native mode 下 **简化** `session_prompt` slot：

| 场景 | 策略 |
|------|------|
| 用户在 **parent**，child `waiting_permission` | 依赖 host Permission UI；**不**绑 child Prompt |
| 用户在 **parent**，design/plan `needs_user` | **Phase 2**：审批类改投 parent controller；或保留 prompt 绑定作 fallback |
| 用户在 **child** route | 原生 child Prompt（replace slot 可返回 null，让 host 默认 Prompt） |

原则：**permission 完全交给 host；文字输入只在 host 不够用时 fallback。**

### 4. TUI 插件瘦身

| 组件 | Native mode |
|------|-------------|
| `app_bottom` | **保留多行 Live Activity 条**（档 B），作为无 Task 卡片时的主列扫读面；不与档 A 互斥 |
| `sidebar_content` | **保留** — 原生没有 workflow task graph 视图 |
| `⌘1..9` 自定义 keymap | **移除或改为可选**；优先文档提示用 `Ctrl+Down` / `session_child_*` |
| `sidebar_footer` | 已移除，保持 |

`app_bottom` 定位：workflow 控制面的**补充心跳**，不是 task 卡片替代品。

### 5. `needs_user` / 审批（串行 design/plan）

原生 Question 不走，需单独策略：

**推荐（Phase 2）— 审批回 parent：**

- `awaiting_design_approval` / `awaiting_plan_approval` 时，`notifyParent` 目标改为 `parent_session_id`（已是），prompt 明确让用户在 **parent** 用自然语言或 `sp_start` 决策。
- design/plan child 的 `needs_user`：优先通知 **parent controller**，而非仅 child 内对话。

**Fallback：**

- 保留 `session_prompt` 绑 child，仅在 host 实测 parent 无法承接输入时启用。

### 6. Agent / 工具边界（不变）

- `superpowers-agent`、`sp-*`：**继续 deny** `task`、`question`。
- 子会话创建路径唯一：`sp_start` → orchestrator → `session.create`。
- 见 `docs/features/controller-native-task-block.md`。

---

## 配置

```json
{
  "plugin": {
    "superpowers-controller": {
      "interaction": {
        "mode": "native"
      }
    }
  }
}
```

| mode | 行为 |
|------|------|
| `legacy` | 无 parentID；dispatch 后切 child；permission 时切 child；完整 app_bottom 面板 |
| `native` | 有 parentID；留 parent；permission 不抢焦点；瘦身 app_bottom |
| `hybrid` | parentID + 仅 permission 不抢焦点；resume 仍切 child（过渡） |

默认 rollout：`legacy` → 实测通过后改 `native`。

---

## 分阶段实施

### Phase 0 — 实测门禁（1–2 天）

- OpenCode **1.16.2** 本地：parentID + design dispatch + 触发 bash permission。
- 记录：parent Permission 是否出现、sidebar 是否还在、SubagentFooter 是否可用。
- 输出：`docs/bugfix/2026-07-11-native-parentid-regression.md`

**未通过则**：不做默认切换；仅文档说明 blocker。

### Phase 1 — 数据层（P0）

- `adapter.createNodeSession` 在 `interaction.mode=native` 时传 `parentID`。
- orchestrator 在 native mode 跳过 `selectWorkflowSession`。
- plugin event：native mode 跳过 `waiting_permission` 的 `selectSession`。
- 测试：`session-adapter.test.ts`、`session-orchestrator.test.ts`、`plugin-progress-event.test.ts`。

### Phase 2 — 可见性 + TUI（P1）

- **档 B**：巩固 `app_bottom` Live Activity 条 + sidebar transcript 尾；native mode 也不砍掉。
- **档 A 调研**：dispatch 后能否由 plugin server 写入 parent task 展示（不经过 agent `task` 工具）。
- native mode 下简化 `session_prompt`（permission 交给 host）。
- keymap `⌘1..9` 在 native mode 可弱化，但不作为唯一进 child 手段。

### Phase 3 — 审批路由（P2）

- serial design/plan 审批与 `needs_user` 优先走 parent controller 通知。
- 更新 `templates.ts` / `notifyParent` 文案与目标 session 策略。
- e2e：parent 停留 + 用户批准 design。

### Phase 4 — 文档与默认（P3）

- 更新哲学文档 §5.6.1、PRD v5 TUI 验收、`docs/modules/progress.md`、`session-orchestrator.md`。
- 实测通过后 `interaction.mode` 默认改为 `native`。

---

## 风险与对策

| 风险 | 对策 |
|------|------|
| parentID 仍丢 sidebar/输入（旧 bug 复现） | Phase 0 门禁；保留 `legacy` 开关 |
| 无 Task 卡片，用户不知 child 在跑 | sidebar 列表 + 单行 app_bottom + toast；文档教 `Ctrl+Down` |
| `needs_user` 无法像原生 Question 一样在 parent 弹出 | Phase 2 审批改投 parent；parallel 已是 parent-led |
| `selectSession` API 形状不稳定 | 弱化依赖；native mode 几乎不调 |
| 哲学/PRD 与实现冲突 | Phase 4 显式修订「自动聚焦 child」→「默认留 parent」 |

---

## 验收标准

### Native mode 必过

1. dispatch design/implement 后，TUI route **仍在 parent**。
2. child 触发 `waiting_permission` 时，**parent 底部**出现 Permission，可 Allow 后继续。
3. `Ctrl+Down` 可进入 child；`Up` 可回 parent。
4. `node_runs`、progress、sidebar 列表与 child session 一致。
5. `superpowers-agent` 调 `task` 仍被 gate 拒绝。
6. `sp_start` → `sp_report` 全流程与 legacy mode 状态机一致。

### 不回退

- 207+ 单元测试全绿。
- build / pack 通过。
- Phase 0 实测报告入库。

---

## 与当前已做工作的关系

- `app_bottom` 多行面板 + `⌘1..9`：**legacy mode 保留**；native mode 降级。
- `sidebar_footer` 删除：**两种 mode 均保留**。
- `parent-progress-notifier` 已删：**与 native 方向一致**（不往 parent 消息流灌进度）。

---

## 建议决策点（需你确认）

1. **默认 mode**：是否接受实测通过后默认 `native`？（建议：是，但 Phase 0 先跑）
2. **无原生 Task 卡片**：不接受「仅 sidebar + `Ctrl+Down`」；并行推进档 B（Live Activity 条）+ 档 A 调研（plugin 代注册 task 展示）
3. **design 审批**：是否同意 Phase 2 把串行审批明确收拢到 parent controller？（建议：是，更贴「parent 是控制面」）

确认后可按 Phase 0 → 1 → 2 顺序开工。
