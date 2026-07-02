# Superpowers Controller

Superpowers Controller is a way to use the Superpowers framework through an Agent.

After installation, select `super-agent`. The Agent follows the Superpowers rules and workflow, and automatically uses the relevant Skills without manual triggering. The model understands the request, splits the work, and produces node outputs. The plugin programmatically controls each step, maintains state, dispatches nodes, records results, and reduces interruptions or workflow drift caused by long-context noise and attention loss.

## Usage

Install with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install.sh | bash
```

Check the install:

```bash
bunx superpowers-controller doctor
opencode agent list
```

Start with `super-agent`:

```bash
opencode --agent super-agent
```

To build this repository and install from source:

```bash
git clone https://github.com/goodjin/superpowers-controller.git
cd superpowers-controller
bun install
bun run build
bash scripts/install.sh
```

This local install path uses the CLI from the current checkout to write OpenCode config and sync the bundled primary skills.

## Design Philosophy

The original Superpowers approach mainly carries working methods through Skills. Skills are lightweight and easy to extend, but long-running work makes the cost visible: too many Skills in one main conversation produce longer, noisier context. Subagents can isolate individual nodes, but orchestration, result collection, failure handling, and continuation still tend to fall back to the main conversation.

Superpowers Controller wraps Skill usage inside an Agent flow. The user selects `super-agent`; the Agent calls the right Skill for the current step; the plugin runtime saves workflow state, validates gates, records artifacts, schedules the next step, and recovers after restarts.

Think of it as a dynamic workflow implementation. The controller can generate or trim the workflow for the request. Once execution starts, node order, status, result recording, and recovery are handled by the plugin.

## Components

```text
super-agent -> Node Session -> Node Agent -> Primary Skill
      |
      v
State / Router / Gate / Session Control
```

- **super-agent**: user entrypoint. It understands the request, prepares the task, restores state, and creates or reuses node sessions.
- **Node agent**: focused role such as `sp-debugger`, `sp-implementer`, or `sp-verifier`.
- **Primary skill**: node method, such as systematic debugging, TDD, or verification.
- **Plugin runtime**: owns state, routing, gates, session control, artifact recording, and recovery.

Core tools:

- `sp_status`: inspect current workflow, nodes, progress, and available capabilities.
- `sp_prepare`: prepare the task, summary, and execution proposal.
- `sp_start`: start, continue, or resolve a workflow.
- `sp_cancel`: cancel the active workflow.
- `sp_report`: let node agents submit structured results, evidence, and follow-up suggestions.

Project-local state:

```text
.opencode/superpowers/current.json
.opencode/superpowers/runs/<run-id>/state.json
.opencode/superpowers/runs/<run-id>/artifacts/*.md
```

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

More design details:

```text
docs/superpowers/specs/2026-06-11-controller-final-design.md
docs/superpowers/specs/2026-06-28-controller-prd-v5.md
```
