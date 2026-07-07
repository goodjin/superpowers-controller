# Foreground Serial Child Sessions

> 2026-07-07 correction: foreground child interaction can switch the OpenCode native session route to the child, but the child route must keep its bottom prompt bound to that child and keep showing live session content. Parent remains the durable workflow anchor for parallel stages and closeout.

## Goal

Improve workflow visibility and interaction by putting the currently active serial child session in the TUI foreground. Design and plan nodes should be visible while they run, and user confirmation for those serial nodes should happen directly in that foreground child session. When the workflow moves into parallel execution, the TUI should return to the parent controller session and keep the parent updated every 10 seconds.

## User Experience Rule

1. Serial design and plan phases are foreground phases.
   - After the controller creates a design child session, the TUI selects that child session.
   - After design is approved and a plan child session is created, the TUI selects the plan child session.
   - The user can watch the child session run and can confirm, revise, or cancel through the prompt bound to that foreground child session.

2. Parallel work is parent-led.
   - After plan approval starts implementation or review tasks that may run in parallel, the TUI selects the parent controller session.
   - The parent session remains the stable control surface while parallel child sessions run.
   - The parent session receives a short workflow progress update every 10 seconds while child sessions are still running.

3. Parent identity remains stable.
   - A foreground child may call `sp_start(approve_design)` or `sp_start(approve_plan)`.
   - Those calls must not replace the workflow's original `parent_session_id` with the child session id.
   - The parent session remains the durable controller session for parallel progress, recovery, and workflow closeout.

## Current Constraints

- Child sessions are created through `src/session/orchestrator.ts` and `src/session/adapter.ts`.
- OpenCode SDK v2 exposes `tui.selectSession(sessionID)` and the `tui.session.select` event shape, but the current adapter only uses `session.create`, `session.prompt`, and `tui.showToast`.
- `sp_start` currently derives `sessionID` from `args.session ?? context.sessionID`, so approval from a child session can accidentally become the new parent session unless the start path preserves the stored parent.
- Parent progress updates already exist in `src/session/parent-progress-notifier.ts`, but the default interval is 30 seconds and it starts for any active running child set.

## Proposed Design

### 1. Add TUI Session Selection To The Adapter

Extend `SessionAdapter` with an optional foreground method:

- `selectSession({ sessionID, reason })`

Implementation order:

1. Try `ctx.client.tui.selectSession({ sessionID })`.
2. If unavailable, try `ctx.client.tui.publish({ body: { type: "tui.session.select", properties: { sessionID } } })`.
3. If unavailable or failed, emit a warning toast/log and keep workflow dispatch alive.

Session selection is a UX side effect. It must not be required for workflow correctness.

### 2. Classify Foreground Policy Per Dispatch

Add a small policy helper near the orchestrator or transition layer:

- `design` and `plan` are serial foreground phases.
- Single non-parallel custom workflow nodes can later opt in, but this feature only changes design and plan.
- Task graph execution phases such as `implement`, `acceptance`, `verification`, and `code-review` stay parent-led, because multiple sessions may run or recover independently.

### 3. Select Child For Serial Dispatch

When `orchestrator.dispatch()` creates or reuses a design/plan child session:

1. Register the node run durably.
2. Schedule the child prompt.
3. Select the child session in the TUI.

The order matters: the user should not be moved to a session before the workflow can show it in state and progress surfaces.

### 4. Preserve Parent Session On Child Approval

Adjust `sp_start` approval and resume paths so that foreground child sessions can drive approval without becoming the parent.

Rules:

- If a run already has `parent_session_id`, approval uses that stored parent by default.
- `context.sessionID` identifies the caller/approver, not necessarily the parent.
- Audit events such as `approved_by_session_id` should still record the child session when the child initiated approval.
- The stored `parent_session_id` should change only when starting a new workflow or explicitly re-parenting, which is out of scope here.

### 5. Return To Parent For Parallel Dispatch

After plan approval dispatches runnable task-graph nodes:

- If dispatch produces implementation/review/check child sessions, select the stored parent session.
- Keep the parent foreground while those nodes run.
- If a parallel child reports `needs_user`, notify the parent and show the pending question in parent progress surfaces. Do not auto-select a parallel child unless a later feature adds an explicit "jump to node" action.

### 6. Change Parent Progress Updates To 10 Seconds For Parallel Work

Update the default parent progress interval from 30 seconds to 10 seconds, but only start the notifier when parent-led parallel child work is active.

Minimum implementation:

- Keep the existing notifier registry and prompt format.
- Change the interval constant to `10_000`.
- Gate automatic start so design/plan foreground-only child runs do not spam parent updates while the user is watching the child.
- Start or continue the notifier when there are running non-foreground child nodes.

## Code Areas

- `src/session/adapter.ts`
- `src/session/orchestrator.ts`
- `src/session/parent-progress-notifier.ts`
- `src/tools/sp-start.ts`
- `src/tools/report-handler.ts`
- `src/router/transition.ts` if dispatch metadata needs foreground hints
- `src/state/store.ts` for parent preservation during approval
- `src/state/types.ts` if explicit foreground metadata is persisted
- `test/session-orchestrator.test.ts`
- `test/parent-progress-notifier.test.ts`
- `test/controller-intake.test.ts`
- `test/sp-record-dispatch.test.ts`

## Acceptance Criteria

- Starting a design node selects the design child session.
- Approving design from the design child starts the plan node and selects the plan child session.
- Approving plan from the plan child preserves the original `parent_session_id`.
- When plan approval dispatches parallel task nodes, the TUI selects the parent session.
- Parent progress updates are sent every 10 seconds during parent-led parallel child execution.
- Parent progress updates are not sent for foreground design/plan-only child execution.
- Missing `tui.selectSession` support does not fail workflow dispatch.
- Existing `needs_user`, `awaiting_design_approval`, and `awaiting_plan_approval` state semantics remain intact.

## Verification Plan

1. Add adapter tests for `selectSession` primary, publish fallback, and failure-to-warning behavior.
2. Add orchestrator tests for design/plan child selection and parent selection after parallel dispatch.
3. Add `sp_start` tests proving child-session approval preserves the stored parent session and records the approving session separately.
4. Update parent progress notifier tests from 30 seconds to 10 seconds and add a foreground-phase suppression case.
5. Run targeted tests:
   - `bun test test/session-orchestrator.test.ts test/parent-progress-notifier.test.ts`
   - `bun test test/controller-intake.test.ts test/sp-record-dispatch.test.ts`
6. Run full validation:
   - `bun run test`
   - `bun run build`
   - `npm pack --dry-run`
7. Update `docs/modules/session-orchestrator.md` and `docs/modules/progress.md` with the final behavior.

## Open Decisions

- Whether plan-only completion should stay on the plan child for final reading or return to parent for closeout. The default proposal is to stay on the plan child because no parallel phase follows.
- Whether a future explicit TUI command should let the user jump from parent to a specific running parallel child. This is useful, but out of scope for this feature.

## Implementation Notes

- Added adapter-level foreground session selection using `tui.selectSession`, with `tui.publish(type="tui.session.select")` fallback and warning-only failure handling.
- `orchestrator.dispatch()` now selects design/plan child sessions for foreground serial work and selects the parent session for parent-led implementation/check dispatches.
- Parent progress updates now default to 10 seconds and only run when a non-design/plan child node is running.
- `sp_start` now preserves the stored `parent_session_id` for existing runs when approvals or resume calls originate from a foreground child session. The child session remains the audit actor through `approved_by_session_id`.

## Verification Results

- `bun test test/session-adapter.test.ts test/session-orchestrator.test.ts test/parent-progress-notifier.test.ts`
- `bun test test/controller-intake.test.ts -t "foreground child"`
- `bun test test/session-adapter.test.ts test/session-orchestrator.test.ts test/parent-progress-notifier.test.ts test/controller-intake.test.ts test/sp-record-dispatch.test.ts`
- `bun test test/install.test.ts test/package-entrypoints.test.ts`
- `bun test test/agents.test.ts test/config-permissions.test.ts test/gates.test.ts test/node-progress.test.ts`
- `bun test test/plugin-config.test.ts test/plugin-progress-event.test.ts test/progress-panel.test.ts test/record-schema.test.ts test/router.test.ts test/runtime-skill-injection.test.ts`
- `bun test test/store-node-runs.test.ts test/store.test.ts test/task-graph.test.ts test/tools.test.ts test/transitions.test.ts test/tui-plugin.test.ts test/support/*.test.ts`
- `bun run build`
- `npm pack --dry-run`

Full `bun run test` was attempted but blocked in the pre-existing deploy runtime test path. Isolated diagnosis showed `scripts/deploy-superagent-runtime.sh deploy` hanging in `verify_runtime` at `superagent agent list | grep -E '^(super-agent|sp-)'`, unrelated to foreground session selection.
