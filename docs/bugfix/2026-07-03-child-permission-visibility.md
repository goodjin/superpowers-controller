# Child Permission Visibility

## Problem

Child node sessions can enter OpenCode permission approval while the user is watching the main Superpowers controller session. The permission request is stored under the child session id, so the main session may only look idle or stalled.

The default node agent permissions also set `bash: "ask"`. After the user has already confirmed a managed workflow, read-only and verification shell probes can still repeatedly stop on per-command permission prompts.

## Scope

- Make child permission waits visible in resident workflow progress surfaces.
- Reduce repeated child-session permission prompts by allowing `bash` for Superpowers node agents by default.
- Keep higher-risk boundaries intact: native `task` remains denied, native child `question` remains denied, and `edit` keeps the existing ask/deny behavior for non-global-allow configurations.
- Do not change OpenCode's native permission storage model in this fix.

## Implementation Plan

1. Update node agent default permission so `bash` is allowed for `sp-*` node agents after workflow dispatch.
2. Update progress rendering so child sessions with live status `waiting_permission` show that state in sidebar and app bottom.
3. Add focused tests for default node bash permission and resident progress rendering.
4. Update module docs for agent permission behavior and progress visibility.
5. Validate with tests, build, package dry run, then publish a patch release.

## Acceptance

- A child session in `waiting_permission` is visible from the main workflow progress surface.
- Node agents no longer prompt for every bash command under the default plugin permission posture.
- Existing native task/question control-plane restrictions remain covered by tests.
