# OpenCode Plugin Cache Refresh

## Problem

The one-click installer calls `opencode plugin superpowers-controller --global --force`, but OpenCode can still reuse an existing package cache under `~/.cache/opencode/packages`. In that case the user config is refreshed while the actual cached npm package remains old.

Observed local state:

- npm registry had `superpowers-controller@0.1.6`.
- `~/.cache/opencode/packages/superpowers-controller` still contained `0.1.2`.
- `~/.cache/opencode/packages/superpowers-controller@latest` still contained `0.1.0`.
- Removing those directories before rerunning `opencode plugin ... --force` installed `0.1.6`.

## Root Cause

OpenCode's plugin npm cache uses package wrapper directories. If the wrapper already contains `node_modules/<package>`, the install path can return the cached entry without checking whether npm has a newer version. The `--force` flag refreshes plugin configuration, but did not force removal of the existing package cache in this observed path.

OpenCode can also use multiple cache keys for the same plugin:

- `superpowers-controller`
- `superpowers-controller@latest`
- legacy/incorrect keys such as `opencode-superpowers-controller@latest`

## Fix Plan

1. Before invoking `opencode plugin "$PACKAGE_NAME" --global --force`, remove known cache directories for this plugin only.
2. Respect `XDG_CACHE_HOME` when computing the OpenCode cache root.
3. Keep the cleanup best-effort so installation still proceeds if the cache directory is absent.
4. Add installer tests that create stale cache directories and assert they are removed.

## Acceptance

- Running the installer removes stale `superpowers-controller` OpenCode plugin cache directories.
- Other plugin caches are not removed.
- Existing installer idempotency still passes.
