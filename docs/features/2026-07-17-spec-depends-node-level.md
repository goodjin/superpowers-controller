# Spec Depends_On Uses Node-Level Gates (Unless Task Graph)

> Superseded by `docs/features/2026-07-18-spec-only-dispatch.md`: dispatch is now fully spec-only; `task_graph` only materializes complete nodes (cross-task deps point at terminal gates).

## Goal

Fix the mismatch where controller-authored orchestration (often with `auto_expansion=false` and no `task_graph`) declared serial implement nodes, but dispatch still required `isTaskLevelPassed` (implement + acceptance + verification + code-review) before unlocking the next implement.

## Decision (Option A)

- **No `task_graph`**: `workflow-spec` `depends_on` / edges use **node-level** passed (literal graph).
- **With `task_graph`**: cross-task implement → implement still requires **task-level** passed, matching planner expansion and per-task check chains.
- `auto_expansion` only controls whether report expansions auto-apply; it does not change this rule by itself.

## Scope

- Change `isDependencySatisfied` in `src/router/workflow-spec-dispatch.ts`.
- Add dispatch coverage for serial implement orchestration without `task_graph`.
- Keep existing task-graph tests (dependent task stays locked until full check chain).
- Update `docs/modules/controller.md` (and related notes if needed).

## Acceptance

- Custom orchestration: `implement-A` passed → `implement-B` (depends_on A) is dispatchable without acceptance/verification/code-review for A.
- Task graph: T1 implement-only still does **not** unlock T2.
- Task graph: T1 full check chain still unlocks T2.
- Build and unit tests pass.
