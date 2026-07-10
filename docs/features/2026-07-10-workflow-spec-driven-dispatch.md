# Workflow-Spec-Driven Dispatch

## Goal

Align `decideNextDispatches` with PRD V5: use `workflow-spec.json` (nodes, edges, depends_on) as the dispatch fact source instead of hardcoded `record.event` switches.

## Scope

- Add spec resolution helpers and edge/depends_on-based runnable node computation.
- Emit edges from built-in workflow templates.
- Expand task graph nodes with per-task check chains in workflow spec.
- Refactor `decideNextDispatches` to delegate to spec-driven logic; synthesize spec from template when durable spec is missing (tests/legacy runs).

## Acceptance

- Existing dispatch tests pass.
- Dispatch after `sp_report` follows workflow-spec edges and node depends_on.
- Failed acceptance/verification/code-review still reuses implementer session when spec defines a failed retry path.
