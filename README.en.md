# Superpowers Controller

Superpowers Controller is a plugin for using the Superpowers framework through an Agent.

After installation, the default entrypoint is set to `superpowers-agent`.

This Agent follows the Superpowers rules and workflow, and automatically uses the relevant Skills without manual triggering.

The model understands the request, splits the work, and produces node outputs.

The plugin programmatically controls each step, maintains state, dispatches nodes, and records results, reducing interruptions or workflow drift caused by long-context noise and attention loss.

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

The installer sets OpenCode `default_agent` to `superpowers-agent`. Start normally:

```bash
opencode
```

You can also select it explicitly:

```bash
opencode --agent superpowers-agent
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

Superpowers Controller wraps Skill usage inside an Agent flow. The user selects `superpowers-agent`; the Agent calls the right Skill for the current step; the plugin runtime saves workflow state, validates gates, records artifacts, schedules the next step, and recovers after restarts.

Persistence is part of the design. Prepare, start, report, gates, node results, and exceptional states are written to project-local files, so interrupted work can resume and later sessions can audit why the workflow moved to a given step.

Think of it as a dynamic workflow implementation. The controller can generate or trim the workflow for the request. Once execution starts, node order, status, result recording, and recovery are handled by the plugin.

## Components

```text
superpowers-agent -> Node Session -> Node Agent -> Primary Skill
      |
      v
State / Router / Gate / Session Control
```

- **superpowers-agent**: user entrypoint. It understands the request, prepares the task, restores state, and creates or reuses node sessions.
- **Node agent**: focused role such as `sp-debugger`, `sp-implementer`, or `sp-verifier`.
- **Primary skill**: node method, such as systematic debugging, TDD, or verification.
- **Plugin runtime**: owns state, routing, gates, session control, artifact recording, and recovery.

Core tools:

- `sp_status`: inspect current workflow, nodes, progress, and available capabilities.
- `sp_prepare`: prepare the task, summary, and execution proposal.
- `sp_start`: start, continue, or resolve a workflow.
- `sp_cancel`: cancel the active workflow.
- `sp_report`: let node agents submit structured results, evidence, and follow-up suggestions.

Built-in workflows:

- `feature`: design/plan, implementation, acceptance, verification, code review, finish.
- `bugfix` / `debug`: root cause first, then repair, regression verification, review, finish.
- `review`: acceptance, verification, code review, and finish for existing changes.
- `verify-finish`: fresh verification before final finish.
- `design-only` / `plan-only` / `review-only`: bounded output only, with no automatic implementation expansion by default.
- `parallel-investigate`: investigate independent directions in parallel, then summarize.
- `single-agent`: dispatch one scoped node for small tasks.

Project-local state:

```text
.opencode/superpowers/current.json
.opencode/superpowers/runs/<run-id>/state.json
.opencode/superpowers/runs/<run-id>/artifacts/*.md
```

## Configuration

This config controls Superpowers Controller runtime behavior in `superpowers-controller.jsonc` under the OpenCode config directory. It does not configure models, providers, or API keys; it controls workflow gates, state retention, and plugin behavior.

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

## Codex weak enhancement (optional)

OpenCode ships the stateful controller. Codex gets a lighter adapter: install selectable agents only. No hooks, no MCP, and no default-agent switch.

Install with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install-codex.sh | bash
```

Uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/uninstall-codex.sh | bash
```

From a local checkout:

```bash
bash scripts/install-codex.sh
```

Then spawn or select `superpowers-agent` in Codex. See `adapters/codex/README.md`.

## Development

```bash
bun install
bun run test
bun run test:codex
bun run build
bun run e2e:opencode
```

More design details:

```text
docs/superpowers/specs/2026-06-11-controller-final-design.md
docs/superpowers/specs/2026-06-28-controller-prd-v5.md
```
