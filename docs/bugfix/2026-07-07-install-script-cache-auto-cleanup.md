# Install Script Cache Auto Cleanup

## Problem

The installer already refreshed the target OpenCode plugin, but stale cache state could still survive in adjacent locations:

- legacy package names under OpenCode's package `node_modules`
- stale `.bin` links from older package names
- old `oh-my-openagent` / `oh-my-opencode` config files
- local checkout installs could still leave old `bunx` package cache directories around

These residues can make OpenCode load older plugin code after a reinstall, or make diagnosis harder because multiple old package names remain on disk.

## Plan

1. Extend `scripts/install.sh` cleanup to remove legacy OpenCode package cache entries, legacy `node_modules` packages, legacy `.bin` links, and stale package-cache manifest dependencies.
2. Remove old user-level plugin config files from `~/.config/opencode` and `~/.opencode`.
3. Remove stale bunx package cache directories for legacy package names on every run, and remove the current package bunx cache only when installing from a local checkout.
4. Add installer tests that seed those stale files and assert they are removed while unrelated cache entries stay intact.
5. Update deployment documentation with the new cleanup boundary.

## Acceptance

- `bun test test/install.test.ts` passes.
- `bun run build` passes.
- `bun run install:local` can reinstall the current checkout and leave OpenCode pointed at the refreshed local package cache.
