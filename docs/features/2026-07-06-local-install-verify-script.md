# Local Install Verify Script

## Goal

Provide a single local command for development verification after changing the plugin. The command should use the current checkout, not the remote `main` branch or the npm published package.

## Scope

- Add a local helper script that runs focused verification, builds the package, installs the plugin through `scripts/install.sh`, and runs `doctor`.
- Add a package script alias so the command is easy to remember.
- Keep the public `scripts/install.sh` behavior unchanged for remote users.
- Do not publish npm or trigger GitHub Actions.

## Acceptance

Run from the repository root:

```bash
bun run install:local
```

The command should:

1. Run focused installer and TUI tests.
2. Build `dist/`.
3. Install the current checkout into the user's OpenCode config.
4. Refresh OpenCode plugin cache through the existing installer path.
5. Run `superpowers-controller doctor` through the existing local installer path.

Use `SUPERPOWERS_CONTROLLER_LOCAL_SKIP_TESTS=1` when only a quick rebuild/install is needed.
