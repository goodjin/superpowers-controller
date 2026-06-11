# Superpowers Controller MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first OpenCode-only MVP of `opencode-superpowers-controller`, a stateful workflow controller for the Superpowers methodology.

**Architecture:** The plugin exports a small OpenCode `PluginModule` and composes config injection, custom tools, project-local workflow state, router decisions, and gate checks through testable modules. Installer only registers the plugin and copies bundled skills/commands; agents and commands are dynamically injected through the plugin config hook.

**Tech Stack:** Bun, TypeScript, `@opencode-ai/plugin`, `zod`, `jsonc-parser`, Bun test.

---

## File Map

- `package.json`: npm package metadata, bin entry, build/test scripts.
- `tsconfig.json`: ESM TypeScript config for Bun.
- `src/index.ts`: default OpenCode plugin export.
- `src/plugin.ts`: plugin module factory and hook composition.
- `src/config/defaults.ts`: default guided config.
- `src/config/schema.ts`: zod schema and exported config types.
- `src/config/load.ts`: project/global config loader.
- `src/state/types.ts`: workflow mode, gate, artifact, state types.
- `src/state/store.ts`: project-local run storage.
- `src/state/transitions.ts`: `sp_record` state transition validator.
- `src/router/modes.ts`: mode metadata, skills, agents, phases.
- `src/router/classify.ts`: explicit command and keyword classifier.
- `src/router/gates.ts`: write/done gate evaluator.
- `src/router/route.ts`: route decision combining command, current state, and classifier.
- `src/tools/*.ts`: `sp_state`, `sp_route`, `sp_next`, `sp_record`, `sp_reset`.
- `src/tools/index.ts`: tool registry.
- `src/agents/index.ts`: dynamic OpenCode agent config records.
- `src/commands/index.ts`: dynamic slash command config records.
- `src/cli/index.ts`: CLI dispatcher.
- `src/cli/install.ts`: safe OpenCode config merge and asset copy.
- `src/cli/doctor.ts`: environment and install checks.
- `assets/skills/*/SKILL.md`: adapted Superpowers skill assets.
- `assets/commands/*.md`: slash command assets.
- `test/*.test.ts`: router, transitions, gates, installer tests.

## Tasks

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`
- Create: `src/plugin.ts`
- Create: `src/config/defaults.ts`
- Create: `src/config/schema.ts`
- Create: `src/config/load.ts`

- [ ] Write package metadata using repo `opencode-superpowers`, npm package `opencode-superpowers-controller`, plugin id `superpowers-controller`, display name `Superpowers Controller for OpenCode`.
- [ ] Add `bun test`, `bun run build`, and CLI bin scripts.
- [ ] Define config defaults: `mode: "guided"`, `tdd: "strict"`, all gates guided or strict according to schema defaults, project-local state.
- [ ] Build a minimal plugin factory that returns `id: "superpowers-controller"` and server hooks.
- [ ] Run `bun run build`; expected result is TypeScript compilation without emitted runtime errors.

### Task 2: Workflow State and Transitions

**Files:**
- Create: `src/state/types.ts`
- Create: `src/state/store.ts`
- Create: `src/state/transitions.ts`
- Create: `test/transitions.test.ts`

- [ ] Write failing tests for legal and illegal `sp_record` gate updates.
- [ ] Implement project-local state paths under `.opencode/superpowers/runs/<run-id>/`.
- [ ] Implement artifact writes before gate updates.
- [ ] Reject attempts to set all gates at once or set evidence-backed gates without matching artifacts.
- [ ] Run `bun test test/transitions.test.ts`; expected result is pass.

### Task 3: Router and Gate Logic

**Files:**
- Create: `src/router/modes.ts`
- Create: `src/router/classify.ts`
- Create: `src/router/route.ts`
- Create: `src/router/gates.ts`
- Create: `test/router.test.ts`
- Create: `test/gates.test.ts`

- [ ] Write failing route tests for explicit commands, current-state override, debug keywords, design keywords, plan keywords, review keywords, verify keywords, skill-authoring keywords, and low-confidence clarify.
- [ ] Write failing gate tests for design approval, debug root cause, plan requirement, red test evidence, and fresh verification.
- [ ] Implement deterministic keyword classification and current-state precedence.
- [ ] Implement mutating tool detection for write/edit/patch/bash and conservative bash mutation patterns.
- [ ] Run `bun test test/router.test.ts test/gates.test.ts`; expected result is pass.

### Task 4: Plugin Tools

**Files:**
- Create: `src/tools/sp-state.ts`
- Create: `src/tools/sp-route.ts`
- Create: `src/tools/sp-next.ts`
- Create: `src/tools/sp-record.ts`
- Create: `src/tools/sp-reset.ts`
- Create: `src/tools/index.ts`
- Modify: `src/plugin.ts`

- [ ] Add tools with OpenCode-compatible argument schemas.
- [ ] Wire tools to state store, router, and transition validator.
- [ ] Ensure `sp_record` writes markdown artifacts and appends history.
- [ ] Ensure `sp_reset` archives current state by clearing `current.json`, not deleting run history.
- [ ] Run `bun test`; expected result is pass.

### Task 5: Dynamic Agents and Commands

**Files:**
- Create: `src/agents/index.ts`
- Create: `src/commands/index.ts`
- Modify: `src/plugin.ts`
- Create: `assets/commands/sp.md`
- Create: `assets/commands/sp-design.md`
- Create: `assets/commands/sp-plan.md`
- Create: `assets/commands/sp-debug.md`
- Create: `assets/commands/sp-execute.md`
- Create: `assets/commands/sp-review.md`
- Create: `assets/commands/sp-verify.md`
- Create: `assets/commands/sp-reset.md`

- [ ] Inject `superpowers`, `sp-designer`, `sp-planner`, `sp-debugger`, `sp-implementer`, `sp-spec-reviewer`, `sp-code-reviewer`, `sp-verifier`, and `sp-finisher`.
- [ ] Include multi-agent support in prompts and routing for `parallel-investigate`, while keeping it optional.
- [ ] Inject slash commands through config hook and map them to the controller agent or node agents.
- [ ] Ensure each node agent prompt requires ending with `sp_record`.
- [ ] Run `bun run build`; expected result is pass.

### Task 6: Skill Assets

**Files:**
- Create: `assets/skills/superpowers-brainstorming/SKILL.md`
- Create: `assets/skills/superpowers-writing-plans/SKILL.md`
- Create: `assets/skills/superpowers-systematic-debugging/SKILL.md`
- Create: `assets/skills/superpowers-test-driven-development/SKILL.md`
- Create: `assets/skills/superpowers-dispatching-parallel-agents/SKILL.md`
- Create: `assets/skills/superpowers-subagent-driven-development/SKILL.md`
- Create: `assets/skills/superpowers-executing-plans/SKILL.md`
- Create: `assets/skills/superpowers-requesting-code-review/SKILL.md`
- Create: `assets/skills/superpowers-receiving-code-review/SKILL.md`
- Create: `assets/skills/superpowers-verification-before-completion/SKILL.md`
- Create: `assets/skills/superpowers-finishing-a-development-branch/SKILL.md`
- Create: `assets/skills/superpowers-using-git-worktrees/SKILL.md`
- Create: `assets/skills/superpowers-using-superpowers/SKILL.md`
- Create: `assets/skills/superpowers-writing-skills/SKILL.md`

- [ ] Copy upstream skill bodies with adapted frontmatter names and descriptions.
- [ ] Keep methodology body intact except for OpenCode naming/tool references where necessary.
- [ ] Confirm all directory names and frontmatter names match OpenCode skill naming rules.

### Task 7: Installer and Doctor

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/install.ts`
- Create: `src/cli/doctor.ts`
- Create: `test/install.test.ts`

- [ ] Write failing JSONC merge test that preserves user fields and appends package entry.
- [ ] Implement `bunx opencode-superpowers-controller install`.
- [ ] Register `opencode-superpowers-controller` in `~/.config/opencode/opencode.jsonc` or `.json`.
- [ ] Copy skill and command assets to `~/.config/opencode/skills/` and `~/.config/opencode/commands/`.
- [ ] Create `~/.config/opencode/opencode-superpowers.jsonc` with guided defaults.
- [ ] Implement `doctor` checks for OpenCode executable/version, plugin entry, skills, commands, state directory writability, and package version.
- [ ] Run `bun test test/install.test.ts`; expected result is pass.

### Task 8: README and Verification

**Files:**
- Create: `README.md`

- [ ] Add the positioning sentence and three boundary statements:
  - `This project builds on the Superpowers methodology.`
  - `It is not the upstream Superpowers plugin.`
  - `Use upstream Superpowers if you only need skills; use this plugin if you want stateful workflow routing and gates.`
- [ ] Explain dynamic injection, project-local state, guided defaults, and strict mode.
- [ ] Run `bun test`.
- [ ] Run `bun run build`.
- [ ] Run `bun run src/cli/index.ts doctor` or equivalent local command after build.

## Self-Review

- Spec coverage: Covers naming, OpenCode-only scope, guided default, adapted skills, project-local state, dynamic injection, optional multi-agent support, doctor, and no first-version uninstall.
- Placeholder scan: No task uses placeholder language for behavior-critical pieces.
- Type consistency: State, gates, router, tools, agents, commands, and installer names match the confirmed product naming.
