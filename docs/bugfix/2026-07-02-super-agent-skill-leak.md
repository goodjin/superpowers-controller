# Bug Fix: super-agent skill leak

## Problem

- Date: 2026-07-02
- Severity: High
- Scope: `super-agent` runtime requests in OpenCode sessions

The local OpenCode session `ses_0dda4b373ffevdHmN4tudSy5N1` in `/Users/jin/github/order` loaded `superpowers-brainstorming` while running as `super-agent`.

## Root Cause

- `src/plugin.ts` merged external `hostConfig.agent` after Superpowers agent definitions, so another plugin or host config could override `super-agent` permissions with broad `* allow`.
- `src/skills/runtime-injection.ts` injected workflow-mode primary skill context into every chat request. When the active workflow entered `design`, the parent `super-agent` request saw `agent: sp-designer` and `primary_skill: superpowers-brainstorming`.
- `src/router/gates.ts` blocked native `task`, but did not hard-block `super-agent` native `skill` calls when effective permissions were broadened.

## Fix Plan

- Make Superpowers-owned agent definitions win over same-name external agent definitions.
- Inject primary-skill runtime context only into registered node sessions, not the parent controller session.
- Add a tool gate that blocks `super-agent` from calling native `skill`; for node agents, allow only their assigned primary skill.
- Add focused tests for config override, runtime injection scope, and skill gate behavior.

## Fix

- `src/plugin.ts`
  - Merges external `hostConfig.agent` first, then Superpowers agent definitions, so `super-agent` and `sp-*` remain controller-owned even when another plugin has already registered agents.
  - Uses `input.sessionID` in `experimental.chat.system.transform`; runtime primary-skill context is emitted only when the session matches a registered `node_run`.
- `src/router/gates.ts`
  - Blocks native `skill` for `super-agent`.
  - Restricts `sp-*` native `skill` calls to the primary skill in `AGENT_SKILL_MAP`.
- `src/skills/runtime-injection.ts`
  - Accepts an optional node context so the injected `agent`, `phase`, and `primary_skill` match the actual child node.
- `test/plugin-config.test.ts`
  - Covers external same-name agent override and parent-vs-child runtime injection.
- `test/gates.test.ts`
  - Covers native `skill` blocking and node primary-skill restriction.

## Verification

- Focused tests passed:
  - `bun test test/agents.test.ts test/gates.test.ts test/runtime-skill-injection.test.ts test/plugin-config.test.ts`
- Build passed:
  - `bun run build`
- Package dry-run passed:
  - `npm pack --dry-run`
- Full test suite passed:
  - `bun run test`
  - Result: 144 pass, 0 fail.
