# Sidebar: Terminal Empty Workflow UX

## Goal

When the current Superpowers workflow is already finished or canceled and has no child nodes, the sidebar should not keep showing a misleading workflow progress block. Prefer the controller / host session view instead, and use clearer empty-state copy when a terminal workflow is still displayed.

## Behavior

1. **Copy**
   - Active / unfinished workflow with no nodes: keep `waiting for node dispatch`.
   - `canceled` with no nodes: `workflow canceled · no child sessions` (if still rendered).
   - `passed` with no nodes: `workflow finished · no child sessions` (if still rendered).
   - Same copy applies to app-bottom empty footer for consistency.

2. **Sidebar visibility**
   - If workflow status is `passed` or `canceled` **and** `node_runs.length === 0`, treat as **no sidebar workflow**:
     - do not render the `SP … (canceled|…)` progress block
     - resolve host mode as if there were no workflow (prefer single-focus controller / active session)
   - Terminal workflows that still have node rows continue to show workflow progress (with status in the header).

## Scope

- `src/tui/progress-panel.ts` (empty footer copy + visibility helper)
- `src/tui.ts` (`assembleSidebarViewModel` / sidebar host mode)
- Tests + `docs/modules/progress.md`

## Acceptance

- Disk `current` pointing at canceled / empty run no longer pins the sidebar to `SP feature · plan (canceled)` + `waiting for node dispatch`.
- Sidebar shows controller / host session focus instead.
- Unfinished empty workflows still show `waiting for node dispatch`.
