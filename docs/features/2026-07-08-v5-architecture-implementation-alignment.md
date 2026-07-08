# V5 Architecture Implementation Alignment

## Context

This feature aligns the current implementation with:

- `docs/superpowers/specs/2026-06-28-controller-prd-v5.md`
- `docs/superpowers/specs/2026-06-29-controller-philosophy-tool-interaction-design.md`

The user requested that every functional area be implemented by subagents. The main agent coordinates, reviews, integrates, and verifies.

## Scope

1. Strict v5 `sp_prepare` / `sp_start` protocol.
2. Prepare-stage `workflow-spec.json` before designer dispatch.
3. No legacy direct `sp_start` public path.
4. `StartConfirmation` and `StartConfig` validation/persistence.
5. Workflow expansion must patch `workflow-spec.json` before dispatch.
6. TUI workflow/session visibility:
   - auto-focus currently running child session when possible,
   - visible session switching hints,
   - right sidebar workflow summary,
   - total/running session counts,
   - TodoWrite-style session list with active sessions first.
7. Tests and module docs aligned with the new architecture.

## Subagent Tasks

### Task A: Strict V5 Tool Protocol

Owned files/modules:

- `src/tools/sp-start.ts`
- `src/tools/sp-prepare.ts`
- directly related tests

Expected outcome:

- `sp_start(start_prepared_task)` requires `prepared_task_id`, `confirmation`, and `start_config`.
- Legacy direct start payload is rejected with actionable feedback.
- `sp_prepare` writes prepare-stage workflow spec before designer dispatch.

### Task B: Workflow-Spec State And Expansion

Owned files/modules:

- `src/state/types.ts`
- `src/state/store.ts`
- `src/state/transitions.ts`
- directly related tests

Expected outcome:

- `StartConfirmation`, staged `WorkflowSpec`, and spec versioning are represented in state.
- Valid workflow expansion writes/patches `workflow-spec.json` before runnable dispatch.
- Runtime does not use workflow id or event kind as a dispatch shortcut.

### Task C: TUI Workflow Session UX

Owned files/modules:

- `src/tui.ts`
- `src/tui/progress-panel.ts`
- `src/session/adapter.ts` if needed for focus events only
- TUI/progress tests

Expected outcome:

- Sidebar shows workflow status, total sessions, running sessions, attention, and all sessions.
- Active sessions sort first.
- Session rows use TodoWrite-style scan layout and visible switching hints.
- TUI focus is based on runtime facts and degrades safely if adapter shortcut support is unavailable.

### Task D: Test And Module Documentation Alignment

Owned files/modules:

- `docs/modules/*.md`
- `docs/modules/testing.md`
- tests not owned by A/B/C that reference legacy v4 behavior

Expected outcome:

- Module docs no longer describe approve-design/approve-plan or direct-start as current v5 behavior.
- Tests assert strict v5 protocol and TUI session visibility.

## Verification

Required before completion:

- Focused tests touched by each task.
- Full `bun test`.
- `bun run build`.
- Report any remaining PRD/docs mismatch separately.
