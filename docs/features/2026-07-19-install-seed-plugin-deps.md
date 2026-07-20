# Install: Seed OpenCode Plugin Cache With Runtime Dependencies

## Goal

Local `install:local` / checkout install must leave OpenCode's npm plugin cache loadable, so `superpowers-agent` and `sp-*` stay visible in `opencode agent list` and `default_agent` works.

## Problem

`seed_opencode_plugin_cache_from_local_checkout` copied `package.json` + `dist` + `assets` into OpenCode cache paths but did not install package dependencies. The bundled plugin imports `@opencode-ai/plugin/tool`. Without that module under the seeded package, OpenCode fails to load the npm plugin entry, agent injection never runs, and the UI falls back to `build`.

## Behavior

- After each local-checkout seed of `superpowers-controller` into OpenCode package cache, install **production** dependencies into that package directory (`bun install --production`).
- Seed multiple cache keys efficiently: install once, then reuse `node_modules` for the other seed targets.
- Fail the seed step if `@opencode-ai/plugin` (including the `./tool` entry) is missing after install.
- Do not change the public plugin config entry (`plugin: ["superpowers-controller"]`) or require users to switch to `file://` plugins.

## Scope

- `scripts/install.sh`
- `docs/modules/deployment.md`
- Installer tests that exercise local cache seed

## Acceptance

- After `bun run install:local` (or checkout `scripts/install.sh`), each seeded cache package can resolve `@opencode-ai/plugin/tool`.
- `opencode agent list` includes `superpowers-agent` and the `sp-*` agents when using the npm package-name plugin entry.
- Focused installer tests pass.
