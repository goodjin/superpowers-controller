# Feature: Recovered Workflow Task Resume

## Background

After plugin restart, active child sessions are not live. Startup reconciliation marks previously `running` nodes as `interrupted` and sets workflow `status` to `recovered_unknown`.

The controller should decide which tasks to resume. The plugin should execute that decision mechanically: pick the next incomplete phase per task graph policy, dispatch fresh child sessions, and append recovery instructions to node prompts.

## Goals

1. Add `sp_start(run_id, resume)` where `resume` is `"all"` or a list of `task_id` values.
2. Do not block recovery while workflow is `recovered_unknown`.
3. Resume strictly by incomplete phase order; no phase skipping.
4. Append recovery context to resumed node prompts.
5. Keep `sp_start(run_id)` without `resume` non-dispatching (controller must be explicit).

## Non-Goals

- No optional `phase` override on resume.
- No revival of old child sessions; always create fresh sessions and new `node_runs`.
- No change to finish / task-level passed gates.

## Public API

```typescript
sp_start({
  run_id: string,
  resume?: "all" | string | string[],
  task_id?: string, // legacy alias: equivalent to resume: [task_id] on recovered workflows
  expected_state_version?: string,
})
```

Behavior:

- `resume: "all"` resumes every incomplete task in `task_graph`.
- `resume: ["t07", "t08"]` resumes only those tasks.
- For each task, plugin finds the first required phase that is not `passed` and dispatches it.
- Workflow `recovered_unknown` becomes `running` after a successful resume request.
- `sp_start(run_id)` without `resume` still returns blocked guidance and dispatches nothing.

## Recovery Prompt

Each resumed node prompt includes:

```markdown
## Recovery Context

This task was interrupted before plugin restart and is now being resumed.

Before doing new work, inspect the current task state:
- If the work is already complete and acceptance criteria are met, submit sp_report(status=passed) with a short summary.
- If the work is incomplete, continue from the interruption point without redoing finished work.

Prior node: {prior_node_id}, phase: {phase}, task: {task_id}.
```

## Verification

```bash
bun run build
bun test test/controller-intake.test.ts test/tools.test.ts
```

## Acceptance Criteria

- `sp_start(run_id, resume="all")` after startup recovery dispatches the next incomplete phase for each incomplete task.
- Resumed prompts contain `## Recovery Context`.
- `sp_start(run_id)` without `resume` does not dispatch on `recovered_unknown`.
- Implement interrupted resumes implement, not verification.
- Module docs updated for controller and state recovery rules.
