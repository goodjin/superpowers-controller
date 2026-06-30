# Isolated Superagent Runtime

## Background

Local OpenCode installs can share the same user config and data directories. The Superpowers Controller needs a repeatable test runtime that can load the local plugin build without changing the user's default OpenCode command or config.

## Scope

- Provide a `superagent` command in `~/.local/bin`.
- Run the isolated OpenCode 1.16.2 binary bundled under `tools/opencode-1.16.2/`.
- Use a separate runtime root under `~/.local/share/superpowers-controller-test`.
- Keep the isolated config in `~/.local/share/superpowers-controller-test/home/.config/opencode/opencode.json`.
- Load the plugin from `file:///Users/jin/github/superpowers-controller/dist/index.js`.
- Use port `5096` for Web access by default.
- Add a one-command deployment script that rebuilds the plugin, syncs skills and MiniMax auth, updates launchers, and restarts the Web server.

## Non-Goals

- Do not modify the default `opencode` binary or symlinks.
- Do not write the Superpowers plugin into `~/.config/opencode`.
- Do not publish or install the package from npm.
- Do not move the user's real OpenCode auth; copy it into the isolated runtime when present.

## Validation

- `superagent --version` reports the isolated OpenCode version.
- `superagent agent list` includes `super-agent` and all `sp-*` node agents.
- `scripts/deploy-superagent-runtime.sh restart` starts a background server on `http://127.0.0.1:5096`.
