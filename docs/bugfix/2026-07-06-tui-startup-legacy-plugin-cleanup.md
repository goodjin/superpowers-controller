# Bug Fix: TUI startup legacy plugin cleanup

## 问题描述
- 日期: 2026-07-06
- 严重程度: Medium
- 影响范围: OpenCode TUI startup, resident progress slots

OpenCode TUI startup can stay on `Loading plugins...` for a long time. Local inspection showed stale user-level dependency state under `~/.config/opencode` and `~/.opencode`, including old `@opencode-ai/plugin` package versions and an obsolete `@mem9/opencode` plugin dependency. OpenCode 1.17.13 also expects TUI slot plugins to register with an `id`, while the resident Superpowers slot registration only passed `slots`.

## 根因分析
- 问题位置: `scripts/install.sh`
  - The installer refreshes `~/.cache/opencode/packages`, but does not remove stale user-level TUI dependency manifests and node modules that OpenCode checks while loading TUI plugins.
- 问题位置: `src/tui.ts`
  - `api.slots.register({ slots })` lacks the plugin `id` required by current OpenCode slot runtime validation.

## 修复方案
- Add installer cleanup for user-level stale TUI dependency state under `~/.config/opencode` and `~/.opencode`.
- Keep cleanup scoped to legacy plugin dependencies and generated package artifacts.
- Register resident slots with `id: "superpowers-controller"`.
- Add regression tests for installer cleanup and slot registration shape.

## 验证步骤
1. Run focused installer and TUI tests.
2. Run build to verify emitted `dist/tui.js` and declarations.
3. Optionally run the one-click installer locally to refresh the user's OpenCode config after release.

## 相关测试
- `test/install.test.ts`
- `test/tui-plugin.test.ts`
