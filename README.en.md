# Superpowers Controller

Superpowers Controller is a stateful control plugin for coding agents.

It builds on the Superpowers methodology, but it is a separate project from the upstream Superpowers plugin. Upstream skills provide working methods. This plugin adds state, routing, gates, session control, and result recording so design, planning, debugging, TDD, review, and verification steps have project-local state, evidence, and enforcement.

One-sentence positioning:

> Superpowers Controller adds state, routing, gates, session control, and result recording on top of the Superpowers methodology, so coding agents can follow disciplined development workflows without relying on prompt discipline alone.

## Boundaries

- This project builds on the Superpowers methodology.
- It is not the upstream Superpowers plugin.
- It is not affiliated with the upstream Superpowers project.
- Use upstream Superpowers if you only need skills; use this plugin if you want state, routing, gates, session control, and result recording.

## Purpose

Agent workflows often fail because the process only lives in prompts. Long context, interrupted work, and a vague "continue" can make a model skip design, start coding without a plan, fix a bug without a root cause, or claim completion without fresh verification.

Final design document:

```text
docs/superpowers/specs/2026-06-11-controller-final-design.md
```

The plugin stores workflow state in the project:

```text
.opencode/superpowers/current.json
.opencode/superpowers/runs/<run-id>/state.json
.opencode/superpowers/runs/<run-id>/artifacts/*.md
```

It records:

- Current workflow: `feature`, `debug`, `plan-only`, `review`, `verify-finish`, `parallel-investigate`
- Current phase and routing state
- Gates such as `design_approved`, `plan_written`, `root_cause_found`, `red_test_seen`, `verification_fresh`
- Node artifacts such as spec, plan, root cause, red test log, review, and verification log
- History for recovery and explanation

## Design

The workflow is split into layers:

```text
Command -> super-agent -> Node Session -> Node Agent -> Primary Skill
             |
             v
       State / Router / Gate / Session Control
```

Layer responsibilities:

- **Command**: user entrypoint, such as `/sp-debug` or `/sp-plan`.
- **super-agent**: primary controller in the main session. It confirms intent, restores state, and creates or reuses child sessions. It does not write code.
- **Node agent**: focused role such as `sp-debugger` or `sp-implementer`.
- **Skill**: node method, such as systematic debugging, TDD, or verification.
- **Plugin state/gate/session control**: stores state, writes artifacts, validates gates, creates or reuses sessions, and intercepts unsafe tool calls.

The model executes node work and submits normalized results through `sp_report`. The plugin owns state, routing, session creation, retry decisions, and persistence.

## Agents and Skills

The plugin dynamically injects these agents:

| Agent | Role |
|---|---|
| `super-agent` | primary workflow controller |
| `sp-designer` | design/spec node |
| `sp-planner` | plan and task graph node |
| `sp-debugger` | root-cause debugging node |
| `sp-investigator` | read-only parallel investigation node |
| `sp-implementer` | implementation / TDD node |
| `sp-acceptance-reviewer` | acceptance review |
| `sp-code-reviewer` | code quality review |
| `sp-verifier` | fresh verification node |
| `sp-finisher` | finish / branch completion node |

The runtime bundle includes only the 8 primary skills directly assigned to node agents:

- `superpowers-brainstorming`
- `superpowers-writing-plans`
- `superpowers-systematic-debugging`
- `superpowers-test-driven-development`
- `superpowers-dispatching-parallel-agents`
- `superpowers-requesting-code-review`
- `superpowers-verification-before-completion`
- `superpowers-finishing-a-development-branch`

Agents and skills are separate layers. An agent is a role. A skill is the method used by that role.

Agent prompts do not copy full skill bodies. They are lightweight role rules that state the agent purpose, permissions, primary skill, and `sp_report` requirement. Detailed workflow behavior remains in the skill files. The final design keeps one primary skill per node session; if another skill is needed, the plugin creates another node session.

The plugin injects runtime skill context when a workflow is active. That context comes from the same node definition used by the router, agent prompts, node task packets, and `sp_next`, which avoids drift between routing and prompt text.

Example:

```text
/sp-debug
  -> super-agent confirms the debug workflow
  -> plugin creates the workflow run
  -> sp-debugger
  -> primary skill: superpowers-systematic-debugging
  -> sp_report submits the root_cause artifact
  -> plugin writes the artifact, opens the root_cause_found gate, and schedules the next step
```

If the user directly selects a node agent such as `sp-debugger`, the node agent still sees its role prompt and primary skill. Direct selection skips the controller's intent confirmation and recovery logic, so `/sp` or `/sp-debug` is the preferred entrypoint.

## Commands

Commands are dynamically injected. The installer does not copy markdown command files.

Injected slash commands:

- `/sp`
- `/sp-prepare`
- `/sp-design`
- `/sp-plan`
- `/sp-debug`
- `/sp-execute`
- `/sp-review`
- `/sp-verify`
- `/sp-cancel`

## Why use this instead of skills directly?

Direct Superpowers skills are a good fit when you already know the process and only need method instructions.

This plugin helps with longer, stateful, or interruptible work:

- "Continue" resumes from workflow state instead of guessing intent again.
- Writes, repair work, and completion claims go through gates.
- Each node records artifacts and evidence through `sp_report`.
- Parallel investigation requires independent problem domains and no shared write conflict.
- Review and verification are separate roles, so implementation does not silently approve itself.
- Project-local `state.json` and artifacts give later sessions something concrete to recover from.

## Install

The npm package name and CLI command are both `superpowers-controller`.

One-click install:

```bash
curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install.sh | bash
```

Manual install:

```bash
bunx superpowers-controller install
```

Check installation:

```bash
bunx superpowers-controller doctor
```

You can also add the npm plugin entry directly to your OpenCode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["superpowers-controller"]
}
```

If you are upgrading from an early development build, replace the old `opencode-superpowers-controller` entry with `superpowers-controller`.

## Configuration

Default mode is guided: gate issues are reported but not blocked. You can make individual gates strict:

```jsonc
{
  "mode": "guided",
  "tdd": "strict",
  "design_gate": "guided",
  "debug_gate": "guided",
  "verification_gate": "guided",
  "state": {
    "scope": "project",
    "retention_days": 30
  }
}
```

`strict` blocks the tool call. `guided` records a warning. `off` disables that gate.

## Development

```bash
bun install
bun run test
bun run build
bun run e2e:opencode
```

The isolated OpenCode 1.16.2 runtime is stored in:

```text
tools/opencode-1.16.2/
```

The smoke e2e uses temporary `HOME` and `XDG_CONFIG_HOME`, loads `file://dist/index.js`, and verifies that OpenCode 1.16.2 can see the 10 dynamically injected agents. It does not require a model account and does not modify the real OpenCode config.
