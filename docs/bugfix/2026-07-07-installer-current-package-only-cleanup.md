# Installer Current Package Only Cleanup

## Problem

The installer cleanup boundary was still broader than intended. It treated historical package names such as `oh-my-openagent`, `oh-my-opencode`, and `opencode-superpowers-controller` as owned cleanup targets.

The required boundary is stricter: the installer may only clean the current package name `superpowers-controller`.

## Plan

1. Remove all historical package names from cleanup lists in `scripts/install.sh`.
2. Keep cache cleanup limited to `superpowers-controller`, `superpowers-controller@latest`, `node_modules/superpowers-controller`, and local checkout `bunx-<uid>-superpowers-controller@latest`.
3. Keep user dependency cleanup limited to `superpowers-controller`.
4. Update installer tests so historical names are preserved like any other unrelated plugin.
5. Update deployment docs to state the exact cleanup boundary.

## Acceptance

- The installer does not remove `oh-my-openagent`, `oh-my-opencode`, or `opencode-superpowers-controller`.
- The installer still refreshes the current `superpowers-controller` cache.
- Installer tests, build, local install verification, and package dry-run pass.
