# Superpowers Controller for OpenCode

Superpowers Controller for OpenCode is a workflow controller plugin for OpenCode.

It builds on the Superpowers methodology, but it is not the upstream Superpowers plugin. The upstream skills mainly provide working methods. This plugin adds a lightweight state machine, routing layer, and gate system on top, so design, planning, debugging, TDD, review, and verification steps have project-local state, evidence, and enforcement.

One-sentence positioning:

> Superpowers Controller for OpenCode adds a lightweight workflow state machine and gate system on top of the Superpowers methodology, so OpenCode agents follow design, planning, debugging, TDD, review, and verification flows without relying on prompt discipline alone.

## Boundaries

- This project builds on the Superpowers methodology.
- It is not the upstream Superpowers plugin.
- Use upstream Superpowers if you only need skills; use this plugin if you want stateful workflow routing and gates.

## Purpose

Agent workflows often fail because the process only lives in prompts. As context grows, or when the user says "continue", the model can skip design, write code without a plan, fix bugs without root cause, or claim completion without fresh verification.

This plugin keeps workflow state in the project:

```text
.opencode/superpowers/current.json
.opencode/superpowers/runs/<run-id>/state.json
.opencode/superpowers/runs/<run-id>/artifacts/*.md
```

It records:

- Workflow mode: `design`, `plan`, `execute`, `debug`, `parallel-investigate`, `review`, `verify-finish`, `skill-authoring`
- Phase and next step
- Gates such as `design_approved`, `plan_written`, `root_cause_found`, `red_test_seen`, `verification_fresh`
- Artifacts such as spec, plan, root cause, red test log, review, verification log
- History for recovery and explanation

## Design

The plugin splits the workflow into four layers:

```text
Command -> Controller Agent -> Node Agent -> Skill
             |
             v
       State / Router / Gate
```

Layer responsibilities:

- **Command**: user entrypoint, such as `/sp-debug` or `/sp-plan`.
- **Controller agent**: `superpowers`; reads state and calls `sp_route` / `sp_next`; it does not directly implement code.
- **Node agent**: focused role such as `sp-debugger` or `sp-implementer`.
- **Skill**: method instructions for a node, such as systematic debugging, TDD, or verification.
- **Plugin state/gate**: stores state, writes artifacts, validates gates, and intercepts unsafe tool calls.

The model handles local reasoning and node output. The plugin handles workflow reliability.

## Agents and Skills

The plugin dynamically injects 9 agents:

| Agent | Role |
|---|---|
| `superpowers` | controller / primary agent |
| `sp-designer` | design node |
| `sp-planner` | plan / skill-authoring node |
| `sp-debugger` | debug node |
| `sp-implementer` | execute / TDD node |
| `sp-spec-reviewer` | spec compliance review |
| `sp-code-reviewer` | code quality review |
| `sp-verifier` | verification node |
| `sp-finisher` | finish / branch completion |

It bundles 14 `superpowers-*` skills:

- `superpowers-brainstorming`
- `superpowers-writing-plans`
- `superpowers-systematic-debugging`
- `superpowers-test-driven-development`
- `superpowers-dispatching-parallel-agents`
- `superpowers-subagent-driven-development`
- `superpowers-executing-plans`
- `superpowers-requesting-code-review`
- `superpowers-receiving-code-review`
- `superpowers-verification-before-completion`
- `superpowers-finishing-a-development-branch`
- `superpowers-using-git-worktrees`
- `superpowers-using-superpowers`
- `superpowers-writing-skills`

Agents and skills are separate layers. An agent is a role. A skill is the method it should follow.

Agent prompts do not copy whole skill bodies. They are lightweight role prompts designed for this plugin: they state the agent's purpose, which skills it should load, and that it must call `sp_record` before ending a node. Detailed workflow behavior remains in the skill files.

When an active workflow exists, the plugin also injects runtime skill context. It comes from the same `MODE_DEFINITIONS` source and includes the current mode, phase, agent, `primary_skill`, `supporting_skills`, and session policy. Agent prompts, router decisions, `sp_next`, and runtime system context now read from the same skill map.

The current policy is: prefer one primary skill per session. If a supporting skill requires substantial independent work, create or route a separate subagent session for it. This is runtime guidance, not a hard second-skill blocker yet. A hard guarantee requires intercepting OpenCode `skill` tool calls and tracking loaded skills per session.

If a user directly selects a node agent such as `sp-debugger`, that agent still follows its role prompt and loads its mapped skill. Direct selection skips the controller's initial routing UX, so `/sp` or `/sp-debug` is preferred. Gate enforcement still lives in the plugin hook.

## Commands

Commands are dynamically injected. The installer does not copy markdown command files.

Injected slash commands:

- `/sp`
- `/sp-design`
- `/sp-plan`
- `/sp-debug`
- `/sp-execute`
- `/sp-review`
- `/sp-verify`
- `/sp-reset`

## Why not just use Superpowers skills directly?

Direct skills are good when you only need method instructions.

This plugin helps when work is longer, more stateful, or easier to interrupt:

- "Continue" resumes from workflow state instead of reclassifying from scratch.
- Writes, repairs, and completion records go through gates.
- Node outputs are recorded through `sp_record`.
- Parallel investigation requires an independence and write-conflict check.
- Multiple agents have fixed responsibilities.
- State and artifacts remain in the project for recovery.

## Install

```bash
bunx opencode-superpowers-controller install
```

Check installation:

```bash
bunx opencode-superpowers-controller doctor
```

## Development

```bash
bun install
bun run test
bun run build
bun run e2e:opencode
```

The OpenCode 1.16.2 e2e runtime is stored in:

```text
tools/opencode-1.16.2/
```

The e2e smoke uses temporary `HOME` and `XDG_CONFIG_HOME`, loads `file://dist/index.js`, and verifies that OpenCode 1.16.2 can see the 9 dynamically injected agents. It does not require a model account and does not modify the real OpenCode config.
