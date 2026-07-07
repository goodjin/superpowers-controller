# OpenCode Child Session Without Native Parent

## Problem

Design/plan workflow nodes need to move the running child session into the foreground so the user can watch progress and answer confirmation prompts in place. The previous implementation created OpenCode sessions with native `parentID`, then selected that child route in the TUI.

In the current OpenCode TUI, native child routes can hide the normal bottom prompt and right sidebar. After the plugin switches to the child route, the user can see a child page but loses the expected input/sidebar surfaces, so approval or follow-up interaction still feels stuck.

## Root Cause

`src/session/adapter.ts` passed `parentID: input.parentSessionID` to `session.create()`. That makes OpenCode treat the node as a native child session route. The Controller also tracks workflow parentage in `WorkflowState.parent_session_id` and `node_runs[].session_id`, so native OpenCode parentage is not required for workflow correctness.

## Change

Create workflow node sessions as ordinary OpenCode sessions:

- Keep `parentSessionID` in the Controller/session adapter API.
- Do not pass `parentID` to OpenCode `session.create()`.
- Continue storing logical parent/child relationship in workflow state.
- Continue selecting foreground child sessions for design/plan phases.

This lets the selected child use the normal interactive session shell while preserving Controller-owned workflow routing.

## Validation

- Add an adapter regression test that asserts `createNodeSession()` omits native `parentID`.
- Run focused session/TUI tests.
- Run build and package dry-run before publishing/installing.
