# Bug Fix: Startup interrupted node recovery

## Problem

- Date: 2026-06-26
- Severity: High
- Scope: SuperAgent restart / Superpowers workflow recovery

When the `superagent` process is stopped and started again, any child session that was running before the process stop is no longer actually running. The current plugin still reads the old `node_runs[].status = "running"` from `.opencode/superpowers/runs/<run-id>/state.json`.

Observed runtime:

- Active workflow: `b99af90a-6cad-4a07-93a7-21ae8b79e472`
- Running node in state: `011-implement-T3`
- Child session: `ses_0fbf382d2ffeITDOz5njdaNWTR`
- Latest progress: `session error: Aborted`, then `session idle`

This leaves the controller in a false-running state. `sp_start(run_id)` then sees a running node and refuses to dispatch anything, which is correct for a live child but wrong after process restart.

## Root Cause

- `src/session/orchestrator.ts` schedules child prompts asynchronously and returns after prompt scheduling. It does not wait for the child session to finish.
- `src/progress/node-progress.ts` records `session.error` and `session.idle` to `progress.jsonl`, but these events do not update `state.json`.
- `src/router/transition.ts` stops recovery when `hasRunningNodeRuns(state)` is true.
- Plugin startup currently creates `ProjectStore` and `NodeProgressStore`, but does not reconcile persisted `running` node runs with the fact that the host process just started and cannot have inherited active child turns.

The missing boundary is a startup reconciliation step. Persisted `running` is durable historical state, not live truth across process restarts.

## Desired Behavior

On plugin load:

1. Read the current workflow state.
2. If the plugin process is freshly starting, treat persisted `node_runs[].status = "running"` as interrupted.
3. Mark those node runs as `interrupted` with `closed_at` / `ended_at` and a recovery note.
4. Mark the workflow as `recovered_unknown` and append a history/event/changelog entry.
5. Do not auto-dispatch replacement work.
6. Let the main controller session ask the user whether to retry, cancel, or inspect.
7. Only after user choice should the controller call `sp_start(run_id, task_id)` or `sp_cancel`.

## Fix Plan

### 1. Add explicit interrupted node state

- Extend `NodeRunStatus` with `interrupted`.
- Treat `interrupted` as blocking/incomplete in task status calculation.
- Keep completed nodes unchanged.

### 2. Add store-level startup reconciliation

Add a method such as:

```ts
recoverInterruptedRunningNodes(args: { reason: string }): WorkflowState | null
```

Behavior:

- Read `current.json`.
- If no current run, no-op.
- Find `node_runs` with `status === "running"`.
- Convert them to `status: "interrupted"`, set `ended_at` and `closed_at`.
- Set workflow `status` to `recovered_unknown`.
- Set `updated_at`.
- Append history entry and `events.jsonl` entry such as `startup_recovered_interrupted_nodes`.
- Append `changelog.md`.
- Be idempotent: second plugin load should not repeatedly append recovery entries if no `running` nodes remain.

### 3. Call reconciliation when plugin loads

In `src/plugin.ts`, after creating the project store and before tools/events use it:

- call `store.recoverInterruptedRunningNodes({ reason: "Plugin process started; previous running child sessions cannot be assumed live." })`
- optionally log a warning through `ctx.client.app.log` if nodes were interrupted.

This is intentionally process-local. It does not need OpenCode DB access for the first fix because a fresh process start is enough to invalidate inherited `running` child turns.

### 4. Make recovery user-mediated

Update `decideFromState()`:

- If workflow `status === "recovered_unknown"`, return a user-facing blocked/wait decision instead of auto-dispatching.
- Message should name interrupted node ids and suggest `sp_start(run_id, task_id)` to retry a specific task, or `sp_cancel` to cancel.

Update `sp_start(run_id, task_id)` behavior:

- If a specific interrupted node/task is requested, create a fresh attempt for the same phase/agent/task.
- Do not reuse the aborted session by default.
- New node should get a new attempt id/session.

### 5. Tests

Add focused tests:

- Store reconciliation converts running nodes to interrupted and workflow to `recovered_unknown`.
- Reconciliation is idempotent.
- `sp_start(run_id)` on `recovered_unknown` does not auto-dispatch.
- `sp_start(run_id, task_id)` dispatches a new attempt for the interrupted task.
- Existing running-node behavior without startup reconciliation still prevents duplicate dispatch.

Suggested commands:

```bash
bun test test/store.test.ts test/controller-intake.test.ts test/task-graph.test.ts
bun run build
```

## Acceptance Criteria

- After stopping and starting `superagent`, stale `running` node runs no longer appear as live sessions.
- `sp_status` shows workflow recovery state clearly.
- No child session is auto-created immediately on plugin load.
- The user/controller decides the next step.
- Retrying an interrupted task creates a new child session attempt.

