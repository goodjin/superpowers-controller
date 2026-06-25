# State Module

## Responsibility

state 模块负责 workflow run 的本地持久化、artifact/report 写入、task graph 规范化、node run 跟踪和 `sp_report` gate 校验。插件的关键判断读取 JSON state，不解析 markdown。

## Files

- `src/state/types.ts`：workflow、record、task graph、gate、artifact 和 `NodeRun` 类型。
- `src/state/store.ts`：读写 current pointer、run directory、state、artifacts、nodes 和 changelog。
- `src/state/transitions.ts`：把 `sp_report` 应用到 workflow state，校验 gate 和 artifact 关系。
- `src/state/record-schema.ts`：严格解析 `sp_report` 输入，拒绝 control-plane 字段。
- `src/state/task-graph.ts`：校验 task dependency、加入共享写文件隐式依赖、计算 runnable tasks。

## Run Layout

```text
.opencode/superpowers/
  current.json
  runs/<run-id>/
    state.json
    workflow.json
    sessions.json
    request.md
    task.md
    proposal.md
    events.jsonl
    changelog.md
    tasks.json
    task_graph.json
    artifacts/*.md
    reports/<task-id>/
      task.md
      report.md
      acceptance.md
      verification.md
      code_review.md
      finish.md
    nodes/<node-id>/
      task.md
      record.json
      output.md
```

## Workflow State

`WorkflowState` 保留旧 e2e 读取的 `mode`、`phase`、`session` 字段，同时新增 control-plane 字段：

- `activation`
- `workflow`
- `entrypoint`
- `limited_context`
- `parent_session_id`
- `current_phase`
- `status`
- `node_runs`
- `pending_question`

其中 `activation` 用来区分：

- `draft`：planning run 已准备，但还没得到最终执行确认
- `active`：已正式进入 workflow 执行链路

## Node Runs

每次 dispatch 创建一个 `NodeRun`：

- `id`
- `task_id`
- `phase`
- `agent`
- `primary_skill`
- `session_id`
- `status`
- `attempts`
- `started_at`
- `reported_at`
- `closed_at`
- `record_path`

`recordNodeResult()` 会把 matching node 从 `running` 更新成 `passed`、`failed`、`blocked` 或 `needs_user`；`progress` 只更新 `reported_at`，不会关闭 session run。记录会写入 `nodes/<node-id>/record.json`、`output.md` 和 `reports/<task-id>/...`。

`addNodeRun()` 是 runtime 确认派发新节点后的恢复点。只要 workflow 还没有 `passed` 或 `canceled`，新增 node run 会把 workflow `status` 设回 `running`，并把 `phase/current_phase` 更新为新节点 phase。这样 acceptance、verification 或 code review 失败后触发 retry implementer 时，UI 不会继续停留在 failed 状态。

## Task Graph

`normalizeTaskGraph()` 会拒绝未知依赖，并为共享可写文件增加隐式依赖。`getRunnableTasks()` 只返回依赖已 passed、未 running、未 failed 的任务；失败任务不会启动依赖它的任务。

`finish` 记录在 `verification_fresh` 之外还会检查 `task_graph`：如果 run 带有 task graph，所有 graph task 都必须已经有 matching `node_runs[].task_id` 且状态为 `passed`。这可以防止 workflow 在 T5/T6/T7 这类任务仍未登记或未完成时进入 `finished/passed`，也避免主会话绕过 Controller 后让 TUI 失去追踪对象。

当前实现还把 graph runnable 判断建立在 `node_runs` 上：implementation、acceptance、verification 和 code review 都会带同一个 `task_id`。Transition 在 `code-review` passed 后回到 `getRunnableTasks()`，继续派发依赖已满足的后续 implementation task；如果所有 graph task 都已经有 passed code-review 且没有 running node，才进入 finish。

后续如果要支持每个 task 自定义裁剪 checks，应把 task passed 从 `node_runs.status` 中独立出来，落到显式 task/check state 上。
