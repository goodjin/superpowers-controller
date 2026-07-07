# Local Install Seeds Real OpenCode Cache Layout

## Problem

Local development install kept the production-style plugin config entry:

```json
"plugin": ["superpowers-controller"]
```

But it only seeded:

```text
~/.cache/opencode/packages/node_modules/superpowers-controller
```

Recent startup evidence showed OpenCode can also create and load package-key caches:

```text
~/.cache/opencode/packages/superpowers-controller
~/.cache/opencode/packages/superpowers-controller@latest
```

That means local verification can diverge from the actual package-name loading path.

## Plan

1. Keep local development using the same package-name plugin entry as users.
2. When installing from a repository checkout, copy the built local package into all OpenCode cache locations that may satisfy `superpowers-controller`.
3. Keep cleanup scoped to the current package name only.
4. Update installer tests to assert all three current-package cache locations are refreshed while unrelated package names remain untouched.
5. Update deployment documentation to describe the local verification boundary.

## Acceptance

- `packages/node_modules/superpowers-controller` is seeded from the local checkout.
- `packages/superpowers-controller/node_modules/superpowers-controller` is seeded from the local checkout.
- `packages/superpowers-controller@latest/node_modules/superpowers-controller` is seeded from the local checkout.
- The config still uses `plugin: ["superpowers-controller"]`.
- Installer tests, build, local install verification, and package dry-run pass.
