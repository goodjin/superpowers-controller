# Bug Fix: sp_prepare task_brief text fields

## Problem

- Date: 2026-07-02
- Severity: Medium
- Scope: `sp_prepare` V5 `task_brief` input contract and rendering.

`sp_prepare` currently declares `constraints`, `acceptance_criteria`, `known_context`, and `risks` as arrays. In real OpenCode tool calls, these fields are often produced as long strings because they are context destined for another model, not structured data for programmatic joins.

When those fields arrive as strings, `renderTaskBrief()` calls `listSection(...).map()` and the tool fails with:

```text
items.map is not a function
```

## Root Cause

- File: `src/tools/sp-prepare.ts`
- The tool schema asks models for arrays for fields that are naturally long prose.
- `normalizeTaskBrief()` trusts the schema shape and does not normalize runtime inputs.
- `listSection()` assumes every section value is `string[]`.

## Planned Fix

1. Change the `task_brief` tool schema for these fields to `string`:
   - `constraints`
   - `acceptance_criteria`
   - `known_context`
   - `risks`
2. Update `NormalizedTaskBrief` to store these fields as optional strings.
3. Replace list rendering with text-section rendering so multiline strings pass through unchanged.
4. Reject non-string values for those fields with a clear `sp_prepare task_brief.<field> must be a string.` error.
5. Update tests to use string task brief fields and add coverage for string rendering.

## Validation

- Run focused tests:

```bash
bun test test/controller-intake.test.ts
```

- Run package checks if implementation is confirmed:

```bash
bun run test
bun run build
```

## Module Docs

Update `docs/modules/controller.md` to document that V5 `task_brief` prose fields are strings intended for model context.
