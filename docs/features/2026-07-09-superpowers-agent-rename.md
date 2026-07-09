# Feature: Rename controller agent to superpowers-agent

## Context

The user-facing OpenCode controller agent is currently registered as `super-agent`. The requested product name is `superpowers-agent`.

This is an agent id / entrypoint rename only. It does not rename:

- npm package: `superpowers-controller`
- repository: `superpowers-controller`
- CLI command: `superpowers-controller`
- isolated launcher command: `superagent`

## Scope

1. Runtime agent catalog registers `superpowers-agent`.
2. Permission gates treat `superpowers-agent` as the controller.
3. Installer writes `default_agent: "superpowers-agent"`.
4. Doctor validates `superpowers-agent`.
5. Runtime parent notifications target `superpowers-agent`.
6. TUI recognizes `superpowers-agent` as the controller session for sidebar fallback.
7. Tests and current docs are updated.
8. Local OpenCode install is refreshed after the build passes.

## Non-Goals

- Do not keep `super-agent` as an active public alias unless tests reveal OpenCode requires a migration bridge.
- Do not rewrite historical bugfix/feature documents whose purpose is to record past behavior.
- Do not change package or repository names.

## Verification

```bash
bun test test/agents.test.ts test/gates.test.ts test/install.test.ts test/tools.test.ts test/tui-plugin.test.ts test/router.test.ts test/plugin-config.test.ts test/deploy-superagent-runtime.test.ts
bun run build
bun run install:local
opencode agent list
```
