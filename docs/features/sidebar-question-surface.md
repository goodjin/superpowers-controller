# Sidebar Question Surface

## Intent

Show child-session question context in `sidebar_content` instead of the prompt-adjacent compact fallback.

## Problem

The compact fallback can show text such as `SP: sp-designer running/busy - question r...`, but that surface is too narrow to explain what the child session is asking. It also competes with the input area.

## Scope

- Keep resident Superpowers content out of home prompt surfaces.
- Stop registering prompt-adjacent resident progress slots.
- Use `sidebar_content` as the main resident surface for running child-session progress.
- When OpenCode exposes pending child questions, show a readable multi-line question summary in `sidebar_content`.
- Keep `superpowers-questions` as the interactive route for reply/reject actions.

## Acceptance

- `session_prompt_right`, `home_prompt`, and `home_prompt_right` are not registered as resident Superpowers slots.
- `sidebar_content` still displays active workflow progress.
- Pending child questions are rendered as readable multi-line sidebar text.
- Existing progress route and question route continue to work.
