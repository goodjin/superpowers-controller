# Superpowers Controller

Superpowers Controller is a task control plugin for coding agents. It moves the Superpowers methodology from "skills remind the model how to work" toward "a plugin maintains state, dispatches nodes, and records results."

Many agent frameworks carry working methods through skills. That is lightweight and easy to extend, but long-running work exposes a practical cost: loading too many skills into one conversation makes context longer and noisier. Running different skills through subagents can isolate part of that context, but orchestration, next-step decisions, and recovery still tend to fall back to the main conversation.

Superpowers Controller lets the model understand the request, split the work, and produce node outputs. The plugin programmatically advances the workflow, persists execution state, and recovers after interruptions or restarts. The goal is simple: no missing nodes, no shuffled order, recorded results, and auditable logs.

It builds on the Superpowers methodology as an independent project, separate from the upstream Superpowers plugin and unaffiliated with the upstream Superpowers project. Upstream skills provide working methods. This plugin adds state, routing, gates, session control, and result recording so design, planning, debugging, TDD, review, and verification steps have project-local state, evidence, and enforcement.

## Usage

After installation, select `super-agent` in OpenCode. Requirement intake, design, planning, execution, verification, review, cancellation, and recovery are then driven by the `super-agent` through plugin tools.

The common path:

```text
User selects super-agent
  -> super-agent understands the request and calls sp_prepare
  -> plugin prepares the task summary, documents, and executable workflow
  -> user confirms and sp_start runs
  -> plugin creates or reuses node sessions
  -> node agent performs the current task and reports through sp_report
  -> plugin records artifacts, updates gates, and schedules the next step
```

The plugin stores execution state in the project:

```text
.opencode/superpowers/current.json
.opencode/superpowers/runs/<run-id>/state.json
.opencode/superpowers/runs/<run-id>/artifacts/*.md
```

It records:

- Current workflow and node graph
- Current phase and routing state
- Gates such as `design_approved`, `plan_written`, `root_cause_found`, `red_test_seen`, `verification_fresh`
- Node artifacts such as spec, plan, root cause, red test log, review, and verification log
- History for recovery and explanation

## Design Philosophy

Superpowers skills are useful because they make proven working methods explicit: brainstorming, planning, systematic debugging, TDD, code review, and verification. The limitation is that a skill is still method text. It can guide a model, but it does not automatically store state, decide who should do the next step, know when to stop, or remember which evidence has already been accepted.

This limitation grows with task length. If the main conversation loads multiple skills, the model has to carry the goal, context, process, prior decisions, and next action in the same window. Noise gradually competes with the important details. Subagents make individual nodes cleaner, but the main conversation still owns task splitting, dispatch, result collection, failure handling, and continuation. Over time, that conversation accumulates process pressure.

Superpowers Controller moves that pressure into the plugin runtime. The model still does the work it is good at: understanding intent, writing designs, finding root causes, implementing code, and verifying results. The plugin connects those nodes: it saves workflow state, validates gates, records artifacts, recovers interrupted work, and passes results to the next node.

Think of it as a dynamic workflow implementation. The controller can generate or trim the workflow for the request. Once execution starts, ordering, node status, result recording, and recovery are handled by the plugin.

## Components

The execution chain is split into layers:

```text
super-agent -> Node Session -> Node Agent -> Primary Skill
      |
      v
State / Router / Gate / Session Control
```

Layer responsibilities:

- **super-agent**: user entrypoint. It understands the request, prepares the task, restores state, and creates or reuses node sessions.
- **Node agent**: focused role such as `sp-debugger` or `sp-implementer`.
- **Skill**: node method, such as systematic debugging, TDD, or verification.
- **Plugin state/gate/session control**: stores state, writes artifacts, validates gates, creates or reuses sessions, and intercepts unsafe tool calls.

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

The runtime bundle includes the primary skills directly assigned to node agents:

- `superpowers-brainstorming`
- `superpowers-writing-plans`
- `superpowers-systematic-debugging`
- `superpowers-test-driven-development`
- `superpowers-dispatching-parallel-agents`
- `superpowers-requesting-code-review`
- `superpowers-verification-before-completion`
- `superpowers-finishing-a-development-branch`

An agent is a role. A skill is a method. The plugin runtime is the advancement and recording mechanism. Agent prompts do not copy full skill bodies; they state the agent purpose, permissions, primary skill, and `sp_report` requirement. Detailed workflow behavior remains in the skill files.

The final design keeps one primary skill per node session. If another skill is needed, the plugin creates another node session. This keeps node context focused while workflow state remains in the plugin.

The plugin injects runtime skill context when a workflow is active. That context comes from the same node definition used by the router, agent prompts, node task packets, and runtime system messages, which avoids drift between routing and prompt text.

The core tool loop stays compact:

- `sp_status`: inspect current workflow, nodes, progress, and available capabilities.
- `sp_prepare`: prepare the task, summary, and execution proposal.
- `sp_start`: start, continue, or resolve a workflow.
- `sp_cancel`: cancel the active workflow.
- `sp_report`: let node agents submit structured results, evidence, and follow-up suggestions.

Direct Superpowers skills are a good fit when you already know the process, the task is short, and state pressure is low. This plugin helps with longer, stateful, or interruptible work:

- "Continue" resumes from workflow state instead of guessing intent again.
- Writes, repair work, and completion claims go through gates.
- Each node records artifacts and evidence through `sp_report`.
- Parallel investigation requires independent problem domains and no shared write conflict.
- Review and verification are separate roles, so implementation does not silently approve itself.
- Project-local `state.json` and artifacts give later sessions something concrete to recover from.

## Install

The npm package name and CLI command are both `superpowers-controller`. The verified runtime requirement is OpenCode `>= 1.16.0`.

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

## Design Docs

More design details:

```text
docs/superpowers/specs/2026-06-11-controller-final-design.md
docs/superpowers/specs/2026-06-28-controller-prd-v5.md
```
