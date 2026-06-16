# Superpowers Controller Final Design

## 定位

Superpowers Controller 是一个面向 coding agents 的状态控制插件。它负责运行时控制，不是 prompt 包；它是独立项目，没有上游 Superpowers 的官方背书。

核心原则：

```text
大模型负责执行节点任务，产出规范化结果。
插件负责创建会话、控制会话、持久化状态、判断结果、推进下一步。
```

大模型不决定下一步派谁，不决定创建几个会话，不决定复用哪个会话，不决定 gate 是否打开。它只在节点会话里执行任务，并通过 `sp_record` 提交结果。

## 运行边界

```text
super-agent 主会话
  -> 理解用户意图
  -> 恢复或创建 workflow run
  -> 向用户确认开始 / 继续 / 重置
  -> 调度节点子会话
  -> 接收 sp_record 后推进状态机

节点子会话
  -> 一个 agent
  -> 一个 primary skill
  -> 一个节点任务模板
  -> 结束时调用 sp_record

插件
  -> 创建 / 复用底层 harness session
  -> 生成节点 task.md
  -> 写 artifacts
  -> 写 state / changelog / node records
  -> 根据 transition table 调度下一步
  -> 用 TUI toast 展示进度，避免污染模型上下文
```

当前实现的首个 adapter 落在 OpenCode 上，所以代码和测试里会出现 OpenCode session、OpenCode plugin hook 和 `opencode-superpowers-controller` 开发包名。产品命名不绑定 OpenCode：长期展示名是 `Superpowers Controller`，包名目标是 `superpowers-controller`。

## Agents

保留节点 agent，不使用单一通用 agent。每个 agent 的职责、权限、任务模板和 primary skill 都不同。agent 不选择 skill，插件根据节点类型指定。

| Agent | 用途 | Primary skill |
|---|---|---|
| `super-agent` | 主会话总控、需求确认、恢复、调度 | 无业务 skill |
| `sp-designer` | 设计方案 | `superpowers-brainstorming` |
| `sp-planner` | 生成计划和 task graph | `superpowers-writing-plans` |
| `sp-debugger` | 定位 root cause | `superpowers-systematic-debugging` |
| `sp-investigator` | 并行只读调查独立问题域 | `superpowers-dispatching-parallel-agents` |
| `sp-implementer` | 执行单个实现任务，按 TDD 写测试和代码 | `superpowers-test-driven-development` |
| `sp-spec-reviewer` | 检查实现是否符合 spec / plan | `superpowers-requesting-code-review` |
| `sp-code-reviewer` | 检查代码质量、风险、测试缺口 | `superpowers-requesting-code-review` |
| `sp-verifier` | fresh verification | `superpowers-verification-before-completion` |
| `sp-finisher` | 收尾、交付选择 | `superpowers-finishing-a-development-branch` |

`skill-authoring` 不属于本项目目标，删除对应 workflow 和 agent 映射。

## Workflows

### Feature Workflow

```text
intake
-> design
-> plan
-> implement task graph
-> spec-review
-> code-review
-> verify
-> finish
```

Review 串行执行。`sp-spec-reviewer` 先跑；通过后再跑 `sp-code-reviewer`。任何 review 失败都派回对应 implementer 会话修复，再重新进入 review。

### Debug Workflow

```text
intake
-> debug-root-cause
-> implement fix
-> spec-review
-> code-review
-> verify
-> finish
```

没有 `root_cause` artifact 时，插件不允许进入修复节点。

### Plan-Only Workflow

```text
intake
-> plan
-> finish
```

用于用户只需要实施计划，不需要执行。

### Review Workflow

```text
intake
-> spec-review
-> code-review
-> optional implement retry
-> verify
-> finish
```

如果从中间开始，run 标记 `entrypoint: "review"` 和 `limited_context: true`。

### Verify-Finish Workflow

```text
intake
-> verify
-> optional implement retry
-> verify
-> finish
```

verification 失败时也要派回 implementer。若没有可复用 implementer session，插件创建新的 retry implementer session，并把 verification log 放进 task packet。

### Parallel-Investigate Workflow

```text
intake
-> independence-check
-> N investigator sessions
-> synthesis
-> optional next workflow
```

只读调查可以并行。进入修复后回到串行实现 / review / verify 链路。

## Task Graph

Plan 阶段产出 task graph。格式保持简单，只用 `depends_on` 表达依赖。

```ts
type TaskGraph = {
  tasks: Array<{
    id: string
    title: string
    summary: string
    depends_on: string[]
    files?: string[]
    test_commands?: string[]
  }>
}
```

调度规则：

```text
depends_on 为空，或依赖任务全部 passed => 可启动
depends_on 未满足 => 等待
任务 failed => 不启动依赖它的任务，复用该任务 implementer session 修复
```

写冲突由插件处理。若两个可运行任务写同一个文件，插件给其中一个任务加入隐式依赖：

```ts
implicit_depends_on: [
  {
    task: "T1",
    reason: "shared writable file: src/state/types.ts"
  }
]
```

`implicit_depends_on` 是插件内部 normalized task graph 的字段，不要求 planner 产出。

`plan.md` 也要写 task graph，给用户和 agent 看；插件只解析 `sp_record.task_graph`，不解析 markdown。

## sp_record

`sp_record` 是大模型提交节点结果的唯一入口。字段分两类：

- 给人和模型读的内容用 markdown string。
- 插件判断需要的内容用枚举、布尔、数组和固定 key。

简化结构：

```ts
type SpRecordInput = {
  event:
    | "intake"
    | "question"
    | "design"
    | "plan"
    | "debug"
    | "red-test"
    | "implementation"
    | "spec-review"
    | "code-review"
    | "verification"
    | "finish"

  status: "passed" | "failed" | "blocked" | "needs_user"

  summary: string

  artifacts?: Partial<Record<
    | "request"
    | "spec"
    | "plan"
    | "root_cause"
    | "red_test_log"
    | "patch_summary"
    | "spec_review"
    | "code_review"
    | "verification_log"
    | "finish_note",
    string
  >>

  gates?: Partial<Record<
    | "request_confirmed"
    | "design_approved"
    | "spec_written"
    | "plan_written"
    | "root_cause_found"
    | "red_test_seen"
    | "implementation_done"
    | "spec_review_passed"
    | "code_review_passed"
    | "verification_fresh",
    boolean
  >>

  checks?: string
  findings?: string

  question?: {
    prompt: string
    options?: string[]
  }

  task_graph?: TaskGraph
}
```

不包含这些字段：

```text
skills_used
next_action
child_session_id
target_session_id
reuse_session_id
create_sessions
```

这些都由插件保存和判断。插件创建节点会话时已经知道 agent、primary skill、session id 和 node id。

## 用户交互

### 需要进入模型上下文的交互

影响任务语义的确认要进入主会话：

```text
我判断这是 feature workflow。
将按 intake -> design -> plan -> implement -> review -> verify 执行。
是否开始？
```

恢复时：

```text
检测到当前项目已有 workflow，处于 code-review。
spec review 已通过，下一步是 code review。
是否继续？
```

### 不进入模型上下文的进度

运行进度用 OpenCode TUI toast 或状态文件展示，不提交给大模型：

```text
Created sp-implementer session for T2
T2 red-test recorded
spec review failed, retry dispatched to implementer session
```

OpenCode SDK 有 `tui.showToast` 能力，适合展示短进度和 gate warning。

### 子会话向用户提问

子会话通过：

```ts
status: "needs_user"
question: { prompt, options }
```

提交问题。默认由 super-agent 主会话转问用户。用户回答后，插件把回答派回原子会话。

高级模式可以允许用户进入子会话继续讨论，但第一版默认不切换用户会话，避免交互分散。

## 持久化目录

每个 workflow run 一个目录：

```text
.opencode/superpowers/
  current.json
  runs/
    <run-id>/
      state.json
      request.md
      proposal.md
      changelog.md
      task_graph.json
      artifacts/
        spec.md
        plan.md
        root_cause.md
        red_test_log.md
        patch_summary.md
        spec_review.md
        code_review.md
        verification_log.md
        finish_note.md
      nodes/
        001-intake/
          task.md
          record.json
          output.md
        002-design/
          task.md
          record.json
          output.md
        003-plan/
          task.md
          record.json
          output.md
        004-implement-T1/
          task.md
          record.json
          output.md
```

文件职责：

| 文件 | 给谁用 | 格式 | 作用 |
|---|---|---|---|
| `state.json` | 插件 | JSON | 当前 workflow、phase、gates、node_runs、artifact paths |
| `request.md` | 用户 / super-agent / 子会话 | Markdown | 原始需求和确认后的范围 |
| `proposal.md` | 用户 / super-agent | Markdown | 启动或恢复前给用户确认的 workflow proposal |
| `changelog.md` | 用户 / super-agent | Markdown append-only | 状态变化和调度记录 |
| `task_graph.json` | 插件 | JSON | plan 产出的任务图和插件加入的隐式依赖 |
| `artifacts/*.md` | 用户 / agent / reviewer | Markdown | 各阶段正式产物 |
| `nodes/*/task.md` | 子会话 agent | Markdown | 插件生成的节点任务包 |
| `nodes/*/record.json` | 插件 | JSON | 节点最终 `sp_record` 原始结果 |
| `nodes/*/output.md` | 用户 / super-agent | Markdown | 子会话输出摘要，不作为状态判断来源 |

插件判断只读 JSON。模型和用户阅读 Markdown。插件不解析 markdown 做关键决策。

## 从中间环节开始

所有中间入口都先经过 intake。super-agent 明确当前入口、已有材料和缺失材料，让用户确认。

### 从 Plan 开始

要求有 spec 或 requirements。没有 spec 时询问用户：

```text
A. 先补 design/spec
B. 用当前描述作为 lightweight spec，直接 plan
```

run 标记：

```json
{
  "entrypoint": "plan",
  "limited_context": true
}
```

### 从 Execute 开始

必须有 plan。没有 plan 时不能直接 execute，只能导入已有 plan、生成 lightweight plan，或回到 plan 阶段。

### 从 Debug 开始

可独立启动。需要 bug report、错误日志或复现描述。产出 `root_cause.md` 后进入 implement fix。

### 从 Review 开始

必须有 patch summary 或当前 diff。run 标记 `entrypoint: "review"` 和 `limited_context: true`。

### 从 Verify-Finish 开始

需要验证目标和命令。失败后可以派回 implementer；若没有原 implementer session，创建新的 retry implementer session。

## 调度状态

插件维护 `node_runs`：

```ts
type NodeRun = {
  id: string
  task_id?: string
  phase: string
  agent: string
  primary_skill?: string
  session_id: string
  status: "running" | "passed" | "failed" | "blocked" | "needs_user"
  attempts: number
  started_at: string
  ended_at?: string
  record_path?: string
}
```

调度只看：

```text
state
task_graph
node_runs
sp_record.status
sp_record.gates
sp_record.artifacts key
```

不看模型自然语言判断下一步。

## 实现优先级

下一轮实现按这个顺序：

1. 替换 `superpowers` 为 `super-agent`，新增 `sp-investigator`。
2. 移除 `skill-authoring` workflow 和 `writing-skills` 映射。
3. 重写 `sp_record` schema，去掉控制面字段。
4. 新增 run 目录结构、`node_runs`、`task_graph.json`。
5. 新增插件内部 transition table。
6. 新增 OpenCode session adapter：`createNodeSession` / `continueNodeSession`。
7. review 改为串行：spec-review -> code-review -> verify。
8. plan task graph 支持 `depends_on`，共享写文件生成隐式依赖。
9. 进度展示走 `tui.showToast`，不进入模型上下文。
