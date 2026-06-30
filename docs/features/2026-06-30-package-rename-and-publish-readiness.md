# Package Rename and Publish Readiness

## Intent

Rename the npm package and CLI from `opencode-superpowers-controller` to `superpowers-controller`, add npm/open-source metadata, and run a release-readiness verification pass.

## Scope

- Update package identity in `package.json`.
- Update installer defaults and CLI help text that write or display the package/bin name.
- Update tests that assert installer behavior.
- Update README installation instructions and npm plugin configuration examples.
- Add npm/open-source metadata:
  - `repository`
  - `homepage`
  - `bugs`
  - `engines`
  - `LICENSE`
- Tighten package contents if needed so `npm pack --dry-run` does not ship test declaration files.
- Run release verification:
  - `bun run build`
  - `bun run test`
  - `bun run test:e2e:opencode`
  - `npm pack --dry-run`

## Non-Goals

- Do not change the plugin runtime id `superpowers-controller`; it already matches the target product name.
- Superseded by the repository rename follow-up: isolated runtime paths now use `~/.local/share/superpowers-controller-test`.
- Do not submit or publish to npm in this task.
- Do not edit unrelated historical docs that mention old design terms unless they are user-facing install/publish docs.
- Do not touch the existing untracked `docs/features/2026-06-30-one-click-install-script.md` unless the user asks.

## Expected File Changes

- `package.json`
- `src/cli/install.ts`
- `src/cli/index.ts`
- `test/install.test.ts`
- `README.md`
- `README.en.md`
- `tsconfig.json` or packaging config if needed to remove test declaration files from the packed artifact
- `LICENSE`
- `docs/modules/deployment.md` or a new module note only if implementation materially changes install/deployment behavior

## Compatibility Notes

Renaming the package changes the OpenCode plugin config entry written by the installer from:

```json
"opencode-superpowers-controller"
```

to:

```json
"superpowers-controller"
```

Existing users with the old package entry will not be automatically migrated unless we add a compatibility migration. For this task, the conservative behavior is:

- New installs write `superpowers-controller`.
- Existing old entries remain untouched unless the installer already rewrites the plugin list through explicit install flow.
- README should mention replacing the old package name if upgrading from a pre-rename build.

## Verification Criteria

- `bun run build` succeeds.
- `bun run test` succeeds.
- `bun run test:e2e:opencode` succeeds.
- `npm pack --dry-run` shows package name `superpowers-controller` and does not include avoidable test declaration files.
- README install examples use `bunx superpowers-controller ...`.
- OpenCode plugin array example uses `"superpowers-controller"`.
