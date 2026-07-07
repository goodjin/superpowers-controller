# Bug Fix: Plan task dependency release

## Problem

- Date: 2026-07-07
- Severity: High
- Scope: task graph scheduling for feature workflows

Feature workflows can contain task graph nodes handled by different node agents. A planner task such as `t01-spec-and-plan` can pass with `event: "plan"` and `status: "passed"`, but downstream implementer tasks were not released.

## Root Cause

- Location: `src/state/task-status.ts`
- The scheduler used workflow-level completion phases for every task in a feature graph.
- For feature workflows, every task was treated as complete only after `implement`, `acceptance`, `verification`, and `code-review` all passed.
- That rule is correct for implementation tasks, but wrong for planner tasks. A `sp-planner` task should satisfy dependencies when its `plan` phase passes.

## Fix Plan

- Keep implementation tasks gated by `implement -> acceptance -> verification -> code-review`.
- Add task-aware completion phases:
  - `sp-planner`: `plan`
  - `sp-designer`: `design`
  - `sp-debugger`: `debug`
  - `sp-investigator`: `investigate`
  - `sp-acceptance-reviewer`: `acceptance`
  - `sp-verifier`: `verification`
  - `sp-code-reviewer`: `code-review`
  - other/default tasks: existing workflow-level phases
- Add a regression test proving a passed planner task unlocks its dependent implementer task.

## Verification

- Run focused transition tests.
- Run build.
