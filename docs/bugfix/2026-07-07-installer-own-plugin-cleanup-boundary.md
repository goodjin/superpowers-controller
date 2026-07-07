# Installer Own Plugin Cleanup Boundary

## Problem

The installer cache cleanup was expanded to remove stale plugin state, but user-level dependency cleanup also included unrelated OpenCode plugins such as `@opencode-ai/plugin`, `@opencode-ai/sdk`, and `@mem9/opencode`.

That is too broad. The installer should only remove Superpowers Controller package names and legacy names that belong to this plugin migration.

## Plan

1. Limit user-level dependency cleanup to `superpowers-controller`, `oh-my-openagent`, `oh-my-opencode`, and `opencode-superpowers-controller`.
2. Keep OpenCode package cache cleanup scoped to the same Controller package names.
3. Update installer tests so unrelated plugin packages and config dependencies remain after installation.
4. Update deployment documentation to describe the narrower boundary.

## Acceptance

- Running the installer does not remove unrelated plugin dependency entries or package folders.
- Stale Controller package names are still removed.
- Installer tests, build, local install verification, and package dry-run pass.
