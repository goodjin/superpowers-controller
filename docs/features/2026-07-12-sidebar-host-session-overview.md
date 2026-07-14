# Sidebar Host Session Overview

## Goal

`sidebar_content` should always show how many OpenCode sessions exist in the current project and which ones are active, not only workflow-bound child sessions on the parent route.

## Requirements

1. Show total session count and running/active count for the current `api.state.path.directory`.
2. List running sessions first with agent, title/summary, and live status.
3. When no Superpowers workflow is active or started, still render the host session overview.
4. When a workflow exists, show host session overview first, then workflow progress below.

## Approach

- Add `src/tui/host-sessions.ts` to load sessions from `api.client.session.list()` when available, filtered by project directory.
- Fallback to `api.state.session.get/status` for known session ids gathered from workflow candidates and the current slot session.
- Use async refresh in the sidebar slot only; keep other resident slots unchanged.
- Improve `selectWorkflowCandidate()` to prefer unfinished/running workflow runs over canceled history when multiple runs share the same parent session.

## Acceptance

- Sidebar shows `OpenCode sessions` header with `total N | running M`.
- With no workflow state, sidebar is not blank and lists active sessions.
- With workflow state, sidebar still shows host overview plus workflow child-session rows.
- Tests cover host-session rendering and no-workflow fallback.
