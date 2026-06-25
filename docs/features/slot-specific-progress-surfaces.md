# Slot-Specific Progress Surfaces

## Intent

Render Superpowers workflow progress differently by TUI surface so the main session and sidebar do not show the same compact line, without adding plugin content to the home screen or prompt-adjacent areas.

## Problem

The resident progress plugin currently registers several slots, but each slot used to share the same compact renderer. That made `app_bottom`, `sidebar_content`, and `sidebar_footer` compete for the same information instead of matching their available space and context. A follow-up check showed the home screen does not have a useful plugin area, and prompt-adjacent areas are too small for child-session questions.

## Scope

- Keep `app_bottom` focused on a short whole-workflow status line.
- Use `sidebar_content` with workflow session props as the running child-session list.
- Use `sidebar_content` for readable pending child-question summaries.
- Do not register prompt-adjacent resident slots.
- Do not register `home_bottom`.
- Keep the detailed per-session process in the `superpowers-progress` route until OpenCode exposes a confirmed main-session content slot.

## Acceptance

- `app_bottom` renders workflow status, phase, task completion count, and running-session count.
- `sidebar_content` renders running session rows on parent/child session surfaces.
- `sidebar_content` renders pending child-question summaries before normal progress.
- Home and prompt-adjacent surfaces render no plugin resident content.
- The full progress route still renders detailed child-session progress.
