# State Module

## Responsibility

state 模块负责 workflow run 的本地持久化、artifact 写入、task graph 规范化、node run 跟踪和 `sp_record` gate 校验。插件的关键判断读取 JSON state，不解析 markdown。

## Files

- `src/state/types.ts`：workflow、record、task graph、gate、artifact 和 `NodeRun` 类型。
- `src/state/store.ts`：读写 current pointer、run directory、state、artifacts、nodes 和 changelog。
- `src/state/transitions.ts`：把 `sp_record` 应用到 workflow state，校验 gate 和 artifact 关系。
- `src/state/record-schema.ts`：严格解析 `sp_record` 输入，拒绝 control-plane 字段。
- `src/state/task-graph.ts`：校验 task dependency、加入共享写文件隐式依赖、计算 runnable tasks。

## Run Layout

```text
.opencode/superpowers/
  current.json
  runs/<run-id>/
    state.json
    request.md
    proposal.md
    changelog.md
    task_graph.json
    artifacts/*.md
    nodes/<node-id>/
      task.md
      record.json
      output.md
```

## Workflow State

`WorkflowState` 保留旧 e2e 读取的 `mode`、`phase`、`session` 字段，同时新增 control-plane 字段：

- `workflow`
- `entrypoint`
- `limited_context`
- `parent_session_id`
- `current_phase`
- `status`
- `node_runs`
- `pending_question`

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
- `ended_at`
- `record_path`

`recordNodeResult()` 会把 matching node 从 `running` 更新成 `passed`、`failed`、`blocked` 或 `needs_user`，并写入 `nodes/<node-id>/record.json` 和 `output.md`。

## Task Graph

`normalizeTaskGraph()` 会拒绝未知依赖，并为共享可写文件增加隐式依赖。`getRunnableTasks()` 只返回依赖已 passed、未 running、未 failed 的任务；失败任务不会启动依赖它的任务。
