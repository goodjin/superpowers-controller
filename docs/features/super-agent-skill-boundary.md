# Agent Skill Boundary

## Background

`super-agent` is the workflow controller. It should confirm intent, inspect state, and dispatch node sessions through plugin tools. It should not load global development skills such as `auto-developer` or `prd-builder-work`, because those skills can bypass the plugin-owned workflow state and node routing contract.

Node agents have an assigned primary skill from `src/router/modes.ts`. They should not load unrelated global skills, because that can bypass the one-node, one-primary-skill contract.

OpenCode's Agent Skills documentation says skills are loaded through the native `skill` tool, can be controlled with `permission.skill`, and can be disabled per agent with `tools.skill = false`.

## Decision

Disable the `skill` tool for `super-agent` and add explicit prompt text saying the controller has no business skill to load.

For each node agent, keep the `skill` tool available but restrict `permission.skill` to the node's assigned primary skill. All other skills are denied.

## Acceptance

- `super-agent` cannot see or call the `skill` tool.
- `super-agent` prompt states that it must not load business skills.
- Node agents can load their assigned primary skill.
- Node agents cannot load unrelated global skills.
