# Official Superpowers Skills Archive

This directory is a documentation archive of the official Superpowers skills from the locally installed Codex plugin cache.

## Source

- Source path: `/Users/jin/.codex/plugins/cache/openai-curated/superpowers/c6ea566d/skills`
- Copied on: 2026-06-16
- Scope: complete `skills/` tree, including `SKILL.md`, prompts, references, scripts, and agent config files.

## Skill Count

The archive contains 14 official skill directories:

- `brainstorming`
- `dispatching-parallel-agents`
- `executing-plans`
- `finishing-a-development-branch`
- `receiving-code-review`
- `requesting-code-review`
- `subagent-driven-development`
- `systematic-debugging`
- `test-driven-development`
- `using-git-worktrees`
- `using-superpowers`
- `verification-before-completion`
- `writing-plans`
- `writing-skills`

## Relationship To Bundled Runtime Skills

The source bundle under `assets/skills/` currently contains 14 `superpowers-*` skill directories. The default installer excludes `superpowers-writing-skills`, so the installed runtime set is 13 skills.

This archive is for source review, comparison, and documentation. Updating files here does not change runtime behavior unless the corresponding files under `assets/skills/` and related router/install logic are updated separately.
