# Feature: V5 Alignment Gap Closure

## Background

`docs/superpowers/specs/2026-06-28-controller-prd-v5.md` is the implementation baseline. The architecture review decided to use strict v5 public behavior:

- No legacy direct `sp_start({ request, workflow, entrypoint, proposal })`.
- No public `approve_design`, `approve_plan`, or `start_entrypoint` start actions.
- Every executable workflow starts from `sp_prepare`, explicit user confirmation, and `sp_start(action="start_prepared_task", prepared_task_id, confirmation, start_config)`.
- Runtime dispatch must read durable `workflow-spec.json` / task graph facts instead of hard-coded workflow kind shortcuts.

This document records the gap-closure work for aligning implementation, tests, and module docs with that decision.

## Goals

1. Enforce strict v5 start preconditions in the public tool surface.
2. Persist user confirmation and `StartConfig` into workflow state.
3. Write prepare-stage and confirmed `workflow-spec.json` artifacts before runtime dispatch.
4. Apply workflow expansion through the workflow spec before dispatching added tasks.
5. Update TUI workflow visibility so the sidebar reflects live workflow/session state.
6. Update tests and module docs so v4 promotion logic is described only as internal migration behavior.

## Non-Goals

- Do not add new public tools.
- Do not reintroduce legacy direct start compatibility.
- Do not make the plugin invent workflow logic outside the model-provided `workflow-spec`.
- Do not remove internal migration helpers unless they block strict public v5 behavior.

## Implementation Slices

### 1. Strict Prepare And Start

- `sp_prepare` accepts v5 task brief / design participation / confirmation context and returns a `prepared_task_id`.
- `sp_prepare` writes prepare-stage `workflow-spec.json` when designer participation is requested.
- `sp_start(action="start_prepared_task")` requires `prepared_task_id`, `confirmation.user_confirmed=true`, and `start_config`.
- Direct start payloads and legacy public start actions are rejected with actionable feedback.

### 2. Workflow Spec Dispatch

- `StartConfig` is normalized into `workflow-spec.json`.
- Workflow expansion reports patch the workflow spec and task artifacts before dispatch.
- Dispatch uses state/task graph/workflow spec facts rather than fixed event chains where a spec is available.

### 3. TUI Session Visibility

- Main workflow progress exposes a focused session candidate.
- `sidebar_content` shows workflow status, total session count, running session count, and all session rows.
- Active and attention-needed sessions sort first.
- Session rows include stable shortcut hints for switching between child sessions.

### 4. Documentation And Tests

- Module docs describe v5 as the current path.
- Legacy candidate promotion is documented only as `ProjectStore` internal migration behavior.
- Tests cover strict public rejection of legacy actions and v5 confirmation/start config requirements.

## Verification

Required checks:

```bash
bun run build
bun test test/controller-intake.test.ts test/sp-record-dispatch.test.ts test/progress-panel.test.ts test/tui-plugin.test.ts test/tools.test.ts
bun test test/deploy-superagent-runtime.test.ts
```

Full root test discovery is expected to include reference fixture tests under `references/oh-my-openagent`; when reporting results, separate project-local tests from reference package tests.

## Acceptance Criteria

- Public `sp_start` schema no longer advertises `start_entrypoint`, `approve_design`, `approve_plan`, or direct start fields as valid start paths.
- Starting a new executable workflow without prepared task id, confirmation, or start config fails.
- Confirmed `StartConfig` is persisted and translated into `workflow-spec.json`.
- Workflow expansion updates durable workflow spec/task artifacts before runnable dispatch.
- TUI sidebar shows current workflow summary and live child-session list.
- Build and relevant tests pass.
