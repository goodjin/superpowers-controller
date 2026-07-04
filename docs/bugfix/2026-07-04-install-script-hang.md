# Install Script Hangs After Installing Message

## Problem

When running:

```bash
curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install.sh | bash
```

users may only see `Installing Superpowers Controller...` for a long time. Local inspection shows the script is blocked inside `bunx superpowers-controller install`, which spawned `bun add superpowers-controller@latest --no-summary --no-cache --force`. The network sockets are stuck in `SYN_SENT` to npm registry IPv6 addresses.

The install script currently captures `run_controller install` into a shell variable, so Bun progress and network stalls are hidden until the command exits. After the first fix, live validation showed a second hang in `opencode plugin superpowers-controller --global --force`; OpenCode's plugin installer also opens npm registry connections and can stall independently of Bun's registry setting.

## Scope

- Improve installer observability so long-running install, refresh, and doctor steps show progress in the terminal.
- Add a timeout around remote `bunx` controller calls so npm registry stalls do not block indefinitely.
- Add a timeout around the OpenCode plugin cache refresh step for the same reason.
- Print actionable fallback guidance when the remote package execution times out.
- Provide an explicit skip switch for the OpenCode cache refresh when the user's network blocks that path.
- Keep the local checkout path unchanged for development installs.

## Implementation Plan

1. Add an `INSTALL_TIMEOUT_SECONDS` setting with a conservative default.
2. Add a small `run_with_timeout` helper that uses `timeout`/`gtimeout` when available, with a portable Perl fallback.
3. Split controller execution into local checkout and remote package paths.
4. For remote package execution, run `bunx superpowers-controller@latest <command>` through the timeout helper.
5. Let the install command stream directly to stdout/stderr instead of capturing it.
6. Keep doctor output captured because the script needs to tolerate only the missing-opencode warning, but capture it through a temporary file while also streaming it.
7. Update deployment module docs with the new installer timeout/progress behavior.
8. Wrap `opencode plugin superpowers-controller --global --force` in the same timeout helper.
9. Add `SUPERPOWERS_CONTROLLER_SKIP_OPENCODE_REFRESH=1` for users who need config installation to complete while OpenCode registry access is blocked.
10. Verify with targeted install tests, build, and package dry-run.

## Acceptance

- The installer no longer silently waits after the initial installing line.
- A hung npm/Bun registry request exits with a readable timeout error.
- A hung OpenCode plugin refresh exits with a readable timeout error.
- Users can explicitly skip the OpenCode plugin cache refresh when needed.
- Existing local one-click install tests still pass.
- CI-safe tests/build/pack remain green.

## Verification

- `bun test test/install.test.ts`
- `bun test $(git ls-files 'test/**/*.test.ts' 'test/*.test.ts' | grep -Ev '^(test/deploy-superagent-runtime\.test\.ts|test/e2e/|test/support/opencode-e2e/)' | sed 's#^#./#')`
- `bun run build`
- `npm pack --dry-run`
