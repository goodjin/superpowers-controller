# Parent Session Periodic Progress Updates

## Goal

After a workflow creates or reuses child sessions, the parent session should receive a short visible progress update every 30 seconds while the workflow is still active. This prevents the user from waiting in an apparently silent main conversation.

## Current Behavior

- Child session dispatch is non-blocking: the controller awaits session creation, records `node_runs`, and schedules `session.prompt()` in the background.
- Child activity is already captured through `progress.jsonl` and rendered in TUI side-channel surfaces such as `sidebar_content`, `sidebar_footer`, and `app_bottom`.
- The parent conversation only receives explicit prompts for special cases such as pending user input.

## Proposed Design

1. Add a parent-session progress notifier owned by the session orchestration layer.
   - Start it after a child session is created or reused and after the node run is durable.
   - Send updates to the parent session every 30 seconds while the workflow has active child nodes.
   - Stop when the workflow reaches a terminal or waiting state, or when no running child node remains.

2. Reuse the existing progress facts instead of inventing a separate progress source.
   - Read `WorkflowState.node_runs`.
   - Read per-node `progress.jsonl` via `createNodeProgressStore`.
   - Format updates using the existing progress-panel model where possible, so parent messages and TUI surfaces agree.

3. Keep the update short and controller-facing.
   - Include workflow status, task/node completion count, running child sessions, and latest activity.
   - Avoid adding large child transcript excerpts.
   - Do not let the periodic update drive workflow transition; it is visibility only.

4. Avoid prompt loops and duplicate timers.
   - Use a per-run notifier registry so repeated dispatches do not create multiple timers for the same parent run.
   - Mark scheduled parent progress prompts as informational.
   - Do not start the notifier in test modes where child prompting is disabled unless the test explicitly covers it.

## Likely Code Areas

- `src/session/orchestrator.ts`
- `src/session/adapter.ts`
- `src/tools/sp-start.ts`
- `src/tools/report-handler.ts` if downstream dispatch also needs to start or stop the notifier
- `src/tui/progress-panel.ts` for reusable concise formatting
- `test/session-orchestrator.test.ts`
- `test/tools.test.ts` or targeted start/report handler tests
- `docs/modules/session-orchestrator.md`
- `docs/modules/progress.md`

## Acceptance Criteria

- When `sp_start` dispatches one or more child sessions, one parent progress update is scheduled every 30 seconds.
- The update is sent to the parent session, not only to TUI toasts or sidebar slots.
- Multiple child dispatches in the same run do not create duplicate 30-second update streams.
- Updates stop after the workflow is finished, canceled, blocked, failed, waiting for user input, or has no running child sessions.
- The update content is derived from workflow state and progress files, not from stale in-memory assumptions.
- Existing non-blocking child prompt behavior remains intact.
- Unit tests cover timer start, duplicate suppression, and stop conditions.
- Build and package checks pass before commit and push.

## Verification Plan

1. Add focused unit tests with fake timers or injectable timer hooks.
2. Run targeted tests for session orchestration, progress formatting, and workflow tools.
3. Run the full test suite.
4. Run build and package validation.
5. Commit and push after checks pass.

## Implementation Notes

- Added `src/session/parent-progress-notifier.ts`.
- The notifier is shared per plugin process and deduplicates by run id.
- It starts only after `onSessionCreated` has registered the child node run.
- It reads fresh `WorkflowState` and `progress.jsonl` on each tick.
- It sends a short parent prompt to `super-agent` every 30 seconds while `status=running` and at least one child node is still `running`.
- It stops when the workflow is waiting, blocked, failed, canceled, passed, or has no running child node.

## Verification Results

- `bun test test/parent-progress-notifier.test.ts test/session-orchestrator.test.ts`
- `bun test test/parent-progress-notifier.test.ts test/session-orchestrator.test.ts test/sp-record-dispatch.test.ts test/controller-intake.test.ts test/progress-panel.test.ts test/tools.test.ts`
- `bun run test`
- `bun run build`
- `npm pack --dry-run`

`npm publish --dry-run` produced a valid tarball listing but returned `You cannot publish over the previously published versions: 0.1.3`; package structure was verified with `npm pack --dry-run`.
