# Bug Fix: sp_report question contract and resident progress visibility

## Problem
- Date: 2026-06-26
- Severity: High
- Scope: Superpowers Controller `sp_report` tool contract, question handling, and resident progress display.

Two issues were observed in the live isolated SuperAgent run:

1. Several `sp_report` calls failed with validation errors around `question.options`.
2. The workflow kept running and child progress was being recorded, but the user-facing resident progress surface did not visibly show current activity.

## Evidence

Current live workflow state:

- Project: `/Users/jin/.local/share/opencode-superpowers-test/project`
- Run: `53099d79-8f20-4231-ab62-94364d41a8ad`
- Current phase at investigation time: `implement`
- Latest running node at investigation time: `017-implement-T4`
- Latest running session at investigation time: `ses_0fea1a9a6ffeUkdn2i62TpiNeg`

`sp_report` validation evidence from the OpenCode DB:

- Repeated error:
  - `question.options.0`: expected string, received object
  - `question.options.1`: expected string, received object
  - `question.options.2`: expected string, received object

Progress capture evidence:

- `nodes/017-implement-T4/progress.jsonl` is actively populated.
- The progress file contains `text`, `tool_pending`, `tool_running`, `tool_completed`, `tool_error`, `patch`, `step`, and `session_status` entries.
- OpenCode DB `part` rows for `ses_0fea1a9a6ffeUkdn2i62TpiNeg` also show active tool/text updates.

This proves progress collection is working. The bug is in the display/lookup surface, not in event capture.

## Root Cause

### 1. Question option contract split

There are currently two different option shapes:

- `sp_report.question.options`: `string[]`
- TUI/OpenCode question bridge options: `{ label: string, description: string }[]`

The model used the richer `{ label, description }` shape inside `sp_report`, which was rejected by `src/state/record-schema.ts`.

The validator is technically correct against the current schema, but the product contract is confusing because the codebase already exposes object-shaped options in another user-question path.

### 2. Resident progress can silently miss the real workflow root

The server plugin records workflow state and node progress under `ctx.directory`:

- `src/plugin.ts`
- `.opencode/superpowers/current.json`
- `.opencode/superpowers/runs/<run-id>/nodes/<node-id>/progress.jsonl`

The TUI plugin reads workflow state from `api.state.path.directory`:

- `src/tui.ts`
- `currentWorkflowState(api)`
- `createNodeProgressStore(api.state.path.directory).readRun(state)`

If the host TUI is opened from a different directory than the workflow project, the TUI surface returns no active workflow and often renders an empty slot instead of a diagnostic. This matches the symptom: the workflow is running and progress exists on disk, but no visible progress appears.

There is a second visibility weakness: several resident slots intentionally return empty strings when session props are missing or the session is not recognized. That is correct for unrelated sessions, but it makes project-root mismatch hard to diagnose.

## Proposed Fix

### Contract unification

Use one question option contract everywhere:

```ts
type QuestionOption = {
  label: string
  description?: string
}
```

Update `sp_report.question.options` to accept object-shaped options. For backward compatibility, continue accepting strings and normalize them to:

```ts
{ label: value }
```

Then update the public tool schema and prompt wording so model-visible guidance shows the object shape directly.

Files:

- `src/state/types.ts`
- `src/state/record-schema.ts`
- `src/tools/sp-report.ts`
- `src/session/templates.ts`
- `src/skills/runtime-injection.ts`
- tests covering string compatibility and object-shaped options

### Progress visibility hardening

Add a small workflow-root resolver for the TUI plugin:

1. Try `api.state.path.directory`.
2. If no current workflow exists, try the known isolated project path only when `SUPERAGENT_PROJECT_DIR` is set or the path exists under the current isolated runtime root.
3. If still missing, return a short visible diagnostic in global/sidebar/compact surfaces instead of silent blank:

```text
SP: no workflow state for <directory>
```

Keep unrelated-session hiding intact when a workflow is found but the slot belongs to an unrelated session.

Files:

- `src/tui.ts`
- `test/tui-plugin.test.ts`
- `docs/modules/progress.md`

## Validation Plan

Run focused tests:

```bash
bun test test/record-schema.test.ts test/question-bridge.test.ts test/tui-plugin.test.ts test/progress-panel.test.ts
```

Run repo gates:

```bash
bun run test
bun run build
```

After implementation and build, redeploy isolated SuperAgent:

```bash
bun run deploy:superagent
```

Then verify against live runtime:

- `sp_report` accepts object-shaped question options.
- Existing string-shaped options still parse.
- `superpowers-progress` route shows progress for the active run.
- Resident slot shows either current progress or a clear diagnostic instead of silent blank.

## Open Decision

Before implementation, confirm this direction:

- Make `{ label, description? }` the canonical model-facing `sp_report.question.options` shape.
- Keep string arrays only as compatibility input.
- Add visible progress diagnostics for root mismatch instead of silently returning blank in global surfaces.
