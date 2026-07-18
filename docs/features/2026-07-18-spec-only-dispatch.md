# Spec-Only Dispatch (Complete Workflow Graph)

## Goal

Make `workflow-spec` the only dispatch authority. Stop using “has `task_graph`?” as a second gate for unlocking nodes or completing the workflow.

## Decision

1. When materializing `task_graph` into the spec, emit a **complete** node graph:
   - each implementer task: `implement → acceptance → verification → code-review`
   - cross-task `depends_on` points at the dependency’s **terminal gate** (`…-code-review` for implementers, else the task’s primary node)
   - template `sp-finisher` (non-task-scoped) is rewired to depend on all task terminal gates
2. `depends_on` / edges use **node-level** passed only. Remove the `isTaskLevelPassed` branch in `isDependencySatisfied`.
3. A node marked passed in the current transition counts only if its own `depends_on` are already satisfied (prevents a bare code-review report from unlocking dependents).
4. `isSpecNodePassed` / `isWorkflowComplete` follow durable node runs and the spec graph, not task-level shortcuts for dispatch.

`task_graph` remains an input that **generates/updates** the spec. `auto_expansion` still only controls whether expansions auto-apply.

## Out of scope

- Changing finish `sp_report` validation via `incompleteTaskIDs` (still a safety check that phases exist; equivalent when the graph was expanded correctly)
- Reworking `task-resume` helpers beyond what breaks from dispatch changes

## Acceptance

- Custom orchestration without `task_graph`: serial implement still unlocks on node passed.
- With `task_graph`: T1 implement-only does **not** unlock T2; T1 full check chain unlocks T2 via `task-T1-code-review`.
- Expanded spec: T2 `depends_on` includes `task-T1-code-review`; finish depends on all task terminal gates.
- Last task code-review can dispatch finisher through the graph (no task_graph-only completion shortcut required for that path).
- Build and focused dispatch tests pass.
