# Native-Only Interaction (Remove legacy/hybrid)

## Goal

Remove `interaction.mode` variants `legacy` and `hybrid`. The product only supports the native parent-led UX.

## Behavior (native only)

- Child sessions are created with `parentID`.
- Dispatch / resume / permission do **not** auto-focus child sessions.
- `needs_user` always notifies the parent controller session.
- TUI: when the current route is the parent session, the bottom input stays on the **parent**; do not bind it to the foreground child. Input binds to a child only when the user has navigated to that child session.

## Config

- Drop `legacy` / `hybrid` from the public schema.
- If an old config still sets `interaction.mode` to those values, coerce to `native` so installs keep working.

## Scope

- `src/config/schema.ts`, `defaults.ts`, `interaction.ts`
- `src/session/adapter.ts`, `orchestrator.ts`
- `src/tools/report-handler.ts`, `src/plugin.ts`
- `src/tui.ts` prompt binding
- Tests that asserted legacy/hybrid behavior
- `docs/modules/session-orchestrator.md`, `progress.md`, related notes

## Acceptance

- No code path selects child on dispatch/resume/permission based on mode.
- Parent-route `session_prompt` does not target a child session.
- Design/plan `needs_user` notifies parent (no legacy child-foreground path).
- Build + focused tests pass; local install ok.
