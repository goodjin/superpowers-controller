# Workflow Progress Prompts

## Background

Superpowers Controller already persists workflow state, gates, artifacts, node runs, and pending questions. Users can inspect that state through tools, but the normal OpenCode interaction does not clearly show which workflow phase is active unless a tool result is expanded.

The goal is to add lightweight user-visible progress prompts for key control-plane transitions without putting progress chatter into model context.

## Scope

- Add a small progress reporter abstraction that can be shared by tools and the session orchestrator.
- Emit progress prompts when:
  - `sp_route` prepares a workflow or resume proposal and waits for confirmation.
  - `sp_start` creates a confirmed run.
  - `sp_record` records a node result.
  - `sp_record` enters `needs_user`, `blocked`, or `finish`.
  - session orchestrator starts and completes create/reuse dispatch.
- Keep progress delivery on `tui.showToast` when available, with `app.log` fallback.
- Keep progress out of model prompts and runtime skill injection.

## Non-Goals

- Do not change workflow routing, gate semantics, or task graph scheduling.
- Do not auto-dispatch the first node from `sp_start`.
- Do not add persistent remote progress storage.
- Do not make node agents produce narrative status messages.

## Event Contract

Each progress update has:

- `stage`: stable machine-readable stage name.
- `title`: short UI title.
- `message`: concise human-readable state.
- `variant`: `info`, `success`, `warning`, or `error`.

Initial stages:

- `waiting_user_confirmation`
- `run_started`
- `node_recorded`
- `waiting_user_input`
- `workflow_blocked`
- `workflow_finished`
- `dispatch_started`
- `node_running`

## Validation

- Unit tests cover progress events from `sp_route`, `sp_start`, `sp_record`, and session dispatch.
- Existing workflow tests should continue passing because progress reporting is side-channel behavior.
