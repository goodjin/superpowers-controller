# E2E Runtime Recovery Coverage

## Goal

根据 `docs/modules` 的当前设计，为 Superpowers Controller 建立一套能验证真实运行行为的 E2E/控制面测试方案，并补齐当前高风险缺口。

本次任务重点不是扩大 happy path 数量，而是验证 runtime 在恢复、取消、进度汇报和 finish 收口时是否仍以 durable state、`node_runs` 和结构化 `sp_report` 为准。

## Design Sources

- `docs/modules/controller.md`
- `docs/modules/state.md`
- `docs/modules/session-orchestrator.md`
- `docs/modules/agents.md`
- `docs/modules/progress.md`
- `docs/modules/testing.md`

## Coverage Matrix

| Area | Required behavior | Primary test layer | Status |
|---|---|---|---|
| Public control surface | Only `sp_status`, `sp_prepare`, `sp_start`, `sp_cancel`, `sp_report` are public. | unit | Covered |
| New run start | Fresh `sp_start` dispatches entrypoint from workflow definition. | controller/e2e | Covered |
| Prepared run activation | Draft with approved task graph dispatches runnable implementer tasks. | controller/e2e | Covered |
| Active run recovery | `sp_start(run_id)` reads durable state before dispatching. | controller | Covered |
| Waiting user recovery | Waiting workflow returns `wait_user`, does not dispatch. | controller | Covered |
| Running node recovery | Existing running node is not duplicated. | controller | Covered |
| Canceled workflow recovery | Canceled workflow does not restart from entrypoint. | controller | Covered |
| Canceled session recovery | `sp_cancel(session_id)` marks only the matching node, and later recovery recalculates transition. | controller | Covered |
| Progress report | `sp_report(status="progress")` updates record/progress only, without downstream dispatch. | report integration | Covered |
| Failed check retry | Failed acceptance/verification/code-review reuses implementer where possible. | report/controller | Covered |
| Task-level passed | A task is complete only after implementation plus required checks pass. | transition/state | Covered |
| Finish node dispatch | Workflows requiring `sp-finisher` dispatch an explicit finish node; `finish` decision itself does not create a session. | transition/e2e | Covered |
| Finish blocked/canceled recovery | Recovery re-dispatches finish or reports blocked recovery, not entrypoint. | controller | Covered |
| Child prompt registration order | Node run is registered before first child prompt. | session orchestrator | Covered |
| Progress UI | Progress is side-channel and not model context. | unit/integration | Covered |

## Test Plan

1. Add focused controller tests for `sp_start(run_id)` recovery:
   - waiting user state returns a `wait_user` decision and does not call the orchestrator.
   - running child node does not create a duplicate session.
   - canceled workflow returns blocked/recovery decision instead of entrypoint dispatch.
   - all task graph tasks with required checks passed dispatch `sp-finisher`.
   - blocked/canceled finish node is re-dispatched as `sp-finisher`.

2. Add transition/state coverage for task-level completion:
   - implementation-only `passed` for a task is not enough to unlock dependents.
   - implementation plus acceptance, verification and code-review unlocks dependents.
   - finish rejects task graph completion if only implementation passed.

3. Add report-handler coverage for `status: "progress"`:
   - node remains running.
   - no downstream dispatch happens.
   - report/progress metadata is still recorded.

4. Keep full OpenCode E2E for representative long flows only:
   - existing `enableChildPrompts` scenarios already cover real child request order.
   - recovery edge cases stay in controller/report tests unless they require provider request ordering.

## Acceptance Criteria

- `bun run test` passes.
- No test relies on parsing markdown artifacts for workflow transition decisions.
- Recovery tests fail if `sp_start(run_id)` falls back to entrypoint when durable state already contains `node_runs`, task graph, waiting state, canceled state, or finish state.
- Task graph dependents do not run after only implementation passed; required checks must pass first.
