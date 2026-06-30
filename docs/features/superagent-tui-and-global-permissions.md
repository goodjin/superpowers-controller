# Superagent TUI and Global Permissions

## Intent

`superagent` should be useful as the main local entrypoint. When started without arguments, it should open an isolated OpenCode TUI in the caller's current working directory and select `super-agent` as the default agent.

The isolated runtime should also persist global OpenCode permissions as allowed so regenerated config keeps the same permission posture after `start` or `restart`.

## Scope

- Update `scripts/deploy-superagent-runtime.sh`.
- Keep the isolated runtime under `~/.local/share/superpowers-controller-test`.
- Keep `start` and `restart` available for explicitly managing the Web server on `http://127.0.0.1:5096`.
- Do not start the Web server from the default no-argument launcher path.
- Default the no-argument launcher project directory to the runtime `$PWD`, with `SUPERAGENT_PROJECT_DIR` as an explicit override.
- Make no changes to the user's default OpenCode config.

## Acceptance

- The generated isolated `opencode.json` contains `"permission": "allow"`.
- The generated `superagent` launcher starts the TUI without starting Web.
- The generated `superagent` launcher uses the caller's current working directory by default.
- The default TUI command selects `super-agent`.
- `scripts/deploy-superagent-runtime.sh deploy` still installs a working launcher and plugin runtime.
