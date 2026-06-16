# Superagent TUI and Global Permissions

## Intent

`superagent` should be useful as the main local entrypoint, not only as a Web server shortcut. When started without arguments, it should ensure the isolated Web runtime is available and then open a TUI attached to that runtime.

The isolated runtime should also persist global OpenCode permissions as allowed so regenerated config keeps the same permission posture after `start` or `restart`.

## Scope

- Update `scripts/deploy-superagent-runtime.sh`.
- Keep the isolated runtime under `~/.local/share/opencode-superpowers-test`.
- Keep the Web server on `http://127.0.0.1:5096` by default.
- Make no changes to the user's default OpenCode config.

## Acceptance

- The generated isolated `opencode.json` contains `"permission": "allow"`.
- The generated `superagent` launcher starts the Web server when needed and then attaches the TUI to it.
- `scripts/deploy-superagent-runtime.sh deploy` still installs a working launcher and plugin runtime.
