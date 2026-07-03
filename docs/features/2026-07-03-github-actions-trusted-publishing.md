# GitHub Actions Trusted Publishing

## Goal

Publish `superpowers-controller` through GitHub Actions trusted publishing so local `npm publish` no longer blocks on per-release OTP or security-key prompts.

## Scope

- Add a manual GitHub Actions workflow for npm publishing.
- Use npm OIDC trusted publishing instead of a long-lived `NPM_TOKEN` secret.
- Keep release validation in the workflow: install, test, build, package dry run, duplicate-version check, publish.
- Document the npm-side trusted publisher configuration.

## Implementation Plan

1. Add `.github/workflows/publish.yml` with `contents: read` and `id-token: write`.
2. Use GitHub-hosted Ubuntu, Node 24, Bun, and npm CLI publishing.
3. Run `bun install --frozen-lockfile`, `bun run test`, `bun run build`, and `npm pack --dry-run` before publish.
4. Reject publication when the package version already exists on npm.
5. Publish with `npm publish --provenance --access public`.
6. Update deployment documentation with the exact npm trusted publisher setup.

## npm Configuration Required

Configure this once on npm:

- Package: `superpowers-controller`
- Page: `https://www.npmjs.com/package/superpowers-controller/access`
- Publisher: GitHub Actions
- Organization or user: `goodjin`
- Repository: `superpowers-controller`
- Workflow filename: `publish.yml`
- Environment name: leave blank
- Allowed actions: `npm publish`

## Acceptance

- The repository contains a manual npm publish workflow.
- The workflow can publish through npm trusted publishing after npm package settings are configured.
- Publishing no longer depends on local CLI OTP prompts.
