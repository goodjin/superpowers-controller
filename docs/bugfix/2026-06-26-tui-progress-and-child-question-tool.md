# Bug Fix: TUI progress visibility and child native question tool

## Problem

- Date: 2026-06-26
- Severity: High
- Scope: TUI resident progress slots and child agent tool registration.

The active workflow was still running, but the main session resident progress surface showed no content.

## Evidence

- Current run: `53099d79-8f20-4231-ab62-94364d41a8ad`
- Current node: `030-design`
- Current child session: `ses_0fe78c00cffeRN2dQN6N1sIyN3`
- `nodes/030-design/progress.jsonl` exists and records `question running`.
- OpenCode DB `part` rows also show native `question` tool status `running`.
- OpenCode pending question API returned an empty list for the workflow project.

## Root Cause

Progress capture is working. The display gap is in resident slot eligibility: `app_bottom` and `sidebar_footer` use workflow-status rendering but currently return empty when host TUI does not pass session props.

The child native question was available because child agents inherit workflow permissions where `question` was allowed. Child agents should not use OpenCode native `question`; they should report user input needs through `sp_report` with `status: "needs_user"` so workflow state and TUI surfaces have one canonical path.

## Fix Plan

- Allow workflow-status resident slots to render the active workflow without session props.
- Keep unrelated session hiding when a concrete unrelated `session_id` is passed.
- Deny and hide native `question` for `sp-*` child agents.
- Add prompt guidance that child agents must use `sp_report needs_user` instead of native `question`.
- Update tests for TUI global workflow-status rendering and child question permissions.

## Validation

Run:

```bash
bun test test/agents.test.ts test/tui-plugin.test.ts
bun run test
bun run build
```
