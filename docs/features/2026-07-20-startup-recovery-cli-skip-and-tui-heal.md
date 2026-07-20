# Startup Recovery: Skip Write on Short CLI + TUI Busy Heal

## Goal

Prevent short-lived OpenCode CLI processes from rewriting workflow state to `interrupted`, and let the long-lived TUI heal false interruptions when the host still shows the child session as busy.

## Background

Startup reconciliation (`reconcileOnLoad` / `recoverInterruptedRunningNodes`) correctly assumes that after a real cold start, persisted `running` nodes are not live. Short CLI commands such as `opencode agent list` also create a project instance and load the server plugin. Those processes cannot see the TUI process’s in-memory busy status, yet they still wrote `interrupted` / `recovered_unknown` to disk while the child session continued in the TUI.

## Behavior

1. **Skip write recovery on short CLI / non-interactive startup**
   - Detect short-lived OpenCode invocations (known CLI subcommands such as `agent`, `debug`, `session`, `export`, …).
   - In those contexts: do not enable `reconcileOnLoad`, and do not call write-path `recoverInterruptedRunningNodes`.
   - Interactive TUI / primary long-lived instance still performs write recovery on cold start.
   - Override: `SUPERPOWERS_SKIP_STARTUP_RECOVERY=1` always skips write recovery; `SUPERPOWERS_FORCE_STARTUP_RECOVERY=1` forces it on.

2. **TUI self-heal**
   - On sidebar refresh, if a node is `interrupted` (or workflow is `recovered_unknown` with such a node) and `api.state.session.status(session_id)` is still an active/busy host status, write the node back to `running` (clear `closed_at` / `ended_at`) and set workflow status to `running` when appropriate.
   - Display uses the healed snapshot so the sidebar stops showing a false `interrupted`.

## Scope

- `src/runtime/startup-recovery-gate.ts` (new)
- `src/plugin.ts`
- `src/state/store.ts` (`healInterruptedBusySessions`)
- `src/tui.ts` (sidebar refresh hook)
- Tests + `docs/modules/state.md` / `progress.md`

## Acceptance

- `opencode agent list` in a project with a live TUI-running child does not rewrite that node to `interrupted`.
- TUI sidebar: interrupted + busy → persisted and shown as `running`.
- Focused unit tests cover the CLI gate and store heal path.
