# State Directory: Move Off `.opencode`

## Goal

Keep plugin config under OpenCode’s config tree, but store workflow run data (workflow-spec, state, documents, progress, etc.) in a project-local directory that is not under `.opencode/`.

## Decision

- **Config (unchanged):** `<project>/.opencode/superpowers.jsonc`
- **Data (new):** `<project>/.superpowers/`
- **Migration:** none. Existing `.opencode/superpowers/` run data is ignored.

## Layout

```text
.superpowers/
  current.json
  runs/<run-id>/
    state.json
    workflow-spec.json
    documents.json
    ...
```

## Scope

- Central path helper used by store, progress, orchestrator, TUI, doctor, tool path strings
- Tests and module docs that document the data root
- Do **not** move config load path or OpenCode plugin install paths

## Acceptance

- New runs write under `.superpowers/`
- Config still loads from `.opencode/superpowers.jsonc`
- Focused unit / TUI / e2e harness path expectations pass
