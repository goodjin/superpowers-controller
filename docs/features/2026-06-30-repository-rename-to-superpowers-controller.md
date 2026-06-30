# Repository Rename To Superpowers Controller

## Goal

Rename the public repository and current paths from `superpowers-agent` / `opencode-superpowers` naming to `superpowers-controller`.

## Decisions

- GitHub repository: `goodjin/superpowers-controller`.
- npm package and CLI remain `superpowers-controller`.
- One-click install URL uses `https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install.sh`.
- User plugin config file is `superpowers-controller.jsonc`.
- Existing `opencode-superpowers.jsonc` is treated as a legacy config path and is migrated into `superpowers-controller.jsonc` on install.
- Isolated test runtime default is `~/.local/share/superpowers-controller-test`.
- Local checkout path should be `/Users/jin/github/superpowers-controller`.

## Validation

- `bun test test/install.test.ts test/package-entrypoints.test.ts`
- `bun run build && npm publish --dry-run`
- `bun run test`
