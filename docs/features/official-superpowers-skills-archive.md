# Official Superpowers Skills Archive

## Background

The repository already bundled Superpowers runtime skills under `assets/skills/`, but the `docs/` directory did not contain a complete copy of the official skill source. That made it harder to compare bundled runtime behavior with the upstream plugin cache, especially for support files such as prompts, references, and scripts.

## Change

- Add `docs/superpowers/official-skills/` as a documentation archive of the official Superpowers `skills/` tree from the locally installed Codex plugin cache.
- Preserve each skill directory, including `SKILL.md`, auxiliary prompts, `agents/openai.yaml`, scripts, and references.
- Add `docs/superpowers/official-skills/README.md` with source path, copy date, skill list, and runtime boundary notes.

## Acceptance

- The official archive contains all 14 skill directories found in the local `openai-curated/superpowers` plugin cache.
- The docs explain that this archive is separate from `assets/skills/`, whose source bundle contains 14 skill directories while the default installer excludes `superpowers-writing-skills`.
- No runtime code or install behavior changes are required for this documentation-only archive.
