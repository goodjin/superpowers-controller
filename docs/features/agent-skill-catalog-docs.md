# Agent And Skill Catalog Docs

## Background

The plugin already had runtime definitions for all injected agents and bundled skills, but the documentation was split across README, design docs, router mappings, and individual `SKILL.md` files. That made it hard to answer which objects exist, what they are for, and when each one applies.

## Change

- Expand `docs/modules/agents.md` into a complete agent catalog covering all injected agents.
- Add `docs/modules/skills.md` as the complete bundled skill catalog.
- Document runtime assignment between node agents and primary skills.

## Acceptance

- Every injected agent from `src/agents/index.ts` is listed with purpose and scenario.
- Every bundled skill under `assets/skills/` is listed with purpose and scenario.
- The docs distinguish runtime primary skills from bundled support skills.
