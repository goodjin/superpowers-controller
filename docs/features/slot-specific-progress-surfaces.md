# Slot-Specific Progress Surfaces

## Intent

Render Superpowers workflow progress differently by TUI surface so the main session, sidebar, and fallback prompt area do not all show the same compact line.

## Problem

The resident progress plugin currently registers several slots, but each slot uses the same compact renderer. That makes `app_bottom`, `sidebar_content`, `sidebar_footer`, `home_bottom`, and `session_prompt_right` compete for the same information instead of matching their available space and context.

## Scope

- Keep `app_bottom` focused on a short whole-workflow status line.
- Use `sidebar_content` without session props as the home/sidebar unfinished task list.
- Use `sidebar_content` with workflow session props as the running child-session list.
- Keep `session_prompt_right` as a short fallback indicator only.
- Keep the detailed per-session process in the `superpowers-progress` route until OpenCode exposes a confirmed main-session content slot.
- Preserve pending child-question precedence in compact fallback text.

## Acceptance

- `app_bottom` renders workflow status, phase, task completion count, and running-session count.
- `sidebar_content` renders unfinished task names on home/no-session surfaces.
- `sidebar_content` renders running session rows on parent/child session surfaces.
- `session_prompt_right` remains truncated and does not carry full detail.
- The full progress route still renders detailed child-session progress.
