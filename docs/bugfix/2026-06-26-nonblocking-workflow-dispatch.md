# Bug Fix: Nonblocking workflow dispatch

## Problem

- Date: 2026-06-26
- Severity: High
- Scope: `sp_start`, `sp_report`, session orchestrator, controller/user-input resume flow

`sp_start` was expected to dispatch child workflow sessions and return control to the parent conversation immediately. In the current implementation it waits for OpenCode `session.prompt()` to finish the target session turn. Long-running child sessions therefore keep the parent tool call in `running`, even though workflow state continues to advance.

The same waiting chain also affects `sp_report`: after a node reports completion, the report handler waits for downstream dispatch to finish. `needs_user` parent notification can also block the reporting child if it waits for the parent session prompt turn.

## Root Cause

The synchronous chain is:

```text
sp_start / sp_report
  -> orchestrator.dispatch() / resumeNode() / notifyParent()
  -> adapter.continueNodeSession()
  -> OpenCode session.prompt()
```

`session.prompt()` is used as a turn-driving API, not a cheap enqueue-only API. Awaiting it means controller tools wait for the prompted session's model turn to complete.

The earlier controller-owned user input fix implemented state handoff and resume prompts, but did not encode nonblocking dispatch as an explicit acceptance criterion. Tests used mock orchestrators that resolved immediately, so they did not catch the blocking behavior.

## Design Rule

`session.create()` may be awaited because the controller needs a session id before it can register `node_runs`.

`session.prompt()` must be treated as background work:

1. Build the task or resume prompt.
2. Resolve or create the target session id.
3. Register the node run before sending the first prompt.
4. Start `continueNodeSession()` without awaiting the target session turn.
5. Return dispatch metadata immediately.
6. Capture background prompt failures through progress/log reporting.

For `waiting_user`, `sp_report(status="needs_user")` should persist `pending_question`, schedule parent notification, and return. The parent `super-agent` handles the user-facing question in the main conversation and later calls `sp_start(run_id, resume_input)`.

## Fix Plan

- Change `src/session/orchestrator.ts` so `dispatch()`, `resumeNode()`, and `notifyParent()` schedule `continueNodeSession()` in the background.
- Preserve the prompt-before-report safety boundary by invoking the registration callback before scheduling prompts for both created and reused sessions.
- Keep tool-level code awaiting orchestrator methods; the methods themselves must return after scheduling, not after the child session completes.
- Add tests where `continueNodeSession()` never resolves and verify:
  - `orchestrator.dispatch()` returns.
  - `orchestrator.resumeNode()` returns.
  - `sp_start(run_id, resume_input)` returns and clears `pending_question`.
  - `sp_report` returns after scheduling downstream dispatch and node registration.
- Update module docs to state that dispatch/resume/notify are enqueue-style operations.

## Validation

1. ✅ `bun test test/session-orchestrator.test.ts`
2. ✅ `bun test test/controller-intake.test.ts`
3. ✅ `bun test test/sp-record-dispatch.test.ts`
4. ✅ `bun test ./test/*.test.ts ./test/support/*.test.ts`
5. ✅ `bun run build`
6. ✅ `npm pack --dry-run`
7. ✅ `bun run deploy:superagent`
