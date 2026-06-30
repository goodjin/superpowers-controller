# One-Click Install Script

## Background

Current installation requires users to know the package binary and run:

```bash
bunx superpowers-controller install
bunx superpowers-controller doctor
```

That command updates OpenCode config and copies bundled primary skills, but it is not a full user-facing installation experience. It does not check runtime prerequisites first, does not explain what changed, and does not give users a single copy-paste command that works from a clean machine.

The repository also has `scripts/deploy-superagent-runtime.sh`, but that script is a local development/runtime deployment path. It builds this checkout, writes an isolated test OpenCode home, and starts a background server. It should remain separate from the normal user install path.

## Goal

Provide a one-click installer for normal users that can be run from a shell, installs or verifies the plugin entry in the user's OpenCode config, syncs bundled skills, runs a health check, and prints clear next steps.

Recommended public command shape:

```bash
curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install.sh | bash
```

For local development before a public URL is final:

```bash
bash scripts/install.sh
```

## Scope

- Add `scripts/install.sh` as the user-facing installer.
- Keep the existing TypeScript CLI installer as the source of truth for config mutation.
- Use `bunx superpowers-controller install` for package-based installation.
- Run `bunx superpowers-controller doctor` after installation.
- Print the config files touched and the command users should try next.
- Add install docs to `README.md`.
- Add focused tests for installer behavior where practical through existing CLI tests and package entrypoint tests.

## Non-Goals

- Do not replace `src/cli/install.ts`.
- Do not use `scripts/deploy-superagent-runtime.sh` for normal user installs.
- Do not modify provider auth, API keys, or model config.
- Do not install or start the isolated `superagent` development runtime by default.
- Do not rename the package/bin in this feature. Use the current executable, `superpowers-controller`.

## Installer Behavior

### 1. Prerequisite checks

The shell script should check:

- `bash` is available.
- `bun` is available, because the current package install command uses `bunx`.
- `opencode` is available, or warn clearly that the plugin can be written but OpenCode must be installed before use.

If `bun` is missing, stop with a short message and installation link guidance. Avoid trying to install Bun automatically.

### 2. Install path

The script should run:

```bash
bunx superpowers-controller install
```

This keeps the JSONC merge, config file selection, default plugin config, and skill-copy logic inside the existing TypeScript installer.

### 3. Verification

After install, run:

```bash
bunx superpowers-controller doctor
```

The script should fail if doctor reports a failed plugin entry, plugin config, skills directory, or writable state directory. If only `opencode` is missing, print it as an actionable prerequisite rather than hiding the install result.

### 4. Idempotency

Running the installer repeatedly should:

- Not duplicate the plugin entry in `~/.config/opencode/opencode.jsonc` or `opencode.json`.
- Preserve existing OpenCode config fields and JSONC comments.
- Preserve and migrate an existing `opencode-superpowers.jsonc` into `superpowers-controller.jsonc`.
- Refresh bundled skill files to the current package version.

### 5. Output

Successful output should include:

- Config path updated.
- Plugin config path.
- Doctor summary.
- Example next command:

```bash
opencode --agent super-agent
```

If OpenCode's exact CLI syntax changes, keep the README wording conservative and point users to `opencode agent list` as the validation command.

## Failure Handling

- Missing Bun: exit non-zero before modifying files.
- `bunx ... install` failure: exit non-zero and print the failing command.
- Doctor failure: exit non-zero after printing all doctor checks.
- Existing config parse issues: rely on the TypeScript installer error, then print the config path users should inspect.

The first version does not need automatic rollback. The installer should avoid partial custom shell edits so the only mutating operation remains the existing CLI installer.

## Files To Change After Approval

- `scripts/install.sh`
- `README.md`
- `README.en.md` if the English install section should stay aligned
- `test/install.test.ts`
- `test/package-entrypoints.test.ts` if package script/bin assertions are added
- `docs/modules/deployment.md`

## Acceptance

- `bash scripts/install.sh` completes on a machine with Bun and OpenCode available.
- Running `bash scripts/install.sh` twice keeps only one `superpowers-controller` plugin entry.
- `bun test test/install.test.ts test/package-entrypoints.test.ts` passes.
- `bun run build` passes.
- `npm pack --dry-run` includes `scripts/install.sh` if the package is expected to ship the script.
- Documentation distinguishes normal user installation from the isolated development runtime.

## Open Questions

- Resolved: use the current repository raw URL, `https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install.sh`.
- Resolved: Bun remains an explicit prerequisite for the first installer.
- Resolved: `scripts/install.sh` installs only the OpenCode plugin and does not create a normal-user `superagent` launcher.
