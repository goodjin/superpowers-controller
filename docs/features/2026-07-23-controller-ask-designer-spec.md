# Design Split: Controller Asks, Designer Specs

## Goal

Keep design **capacity** on `sp-designer`, but move all **user clarifying dialogue** to `superpowers-agent`. Designer runs in brief-driven mode: produce candidate spec from the prepared brief, do not interview the user in the child session.

## Why

Official brainstorming asks one question at a time and seeks sectional approval. When that runs inside `sp-designer`, every question becomes a child-session interaction (or `needs_user` round-trip). Users get stuck when focus fails to return to the controller.

## Behavior

### Controller (`superpowers-agent`)

1. Before `sp_prepare` for design-heavy work, clarify purpose / constraints / success criteria / key tradeoffs **in the main session**.
2. Encode answers in `task_brief` (and thus `request.md` / `task.md` / `proposal.md`).
3. When designer participation is needed, pass `design_participation.mode=brainstorm|design` with `blocking_questions_allowed` omitted or `false` (default).
4. After designer reports a candidate, show it to the user in the **main** session for approval / revision.
5. If designer reports `blocked` for missing facts, ask the user in the main session and reprepare / enrich the brief—do not send the user into the designer session to chat.

### Designer (`sp-designer`)

1. Treat node prompts as **Design Brief Mode** by default.
2. Load brainstorming skill for method (explore context, approaches, write spec), but **skip** interactive clarifying / mid-design user approval loops when the brief is present.
3. Do **not** use `sp_report(status=needs_user)` for preference/clarification questions.
4. If the brief is insufficient, `sp_report(status=blocked)` with a concrete missing-fact list for the controller.
5. On success, `sp_report(status=passed)` with `artifacts.spec` and `gates.spec_written`.

### Prepare / task packet

- Design-phase packets include a Design Brief Mode context section and pull `request.md` / `task.md` / `proposal.md` as source artifacts.
- `blocking_questions_allowed` defaults to `false` when designer participation is enabled.
- Brainstorming skill documents the Controller brief-driven override.

## Non-goals

- Removing `sp-designer` or design nodes from built-in workflows.
- Making the controller write full formal specs itself (optional later).
- Hard runtime rejection of every designer `needs_user` (prompt + packet contract first; can tighten later).

## Related fix

`shouldEscalateEmptyDispatch` now skips draft workflows. `proposal_only` prepare intentionally has zero child decisions while awaiting confirmation; escalating that to `waiting_controller_decision` blocked `sp_start`.

## Scope

- `src/agents/index.ts`
- `src/session/templates.ts`
- `src/tools/sp-prepare.ts`
- `assets/skills/superpowers-brainstorming/SKILL.md`
- Tests + `docs/modules/controller.md` / `agents.md`

## Acceptance

- Controller prompt tells the model to clarify in the main session and keep designer non-interactive by default.
- Designer agent prompt forbids clarifying `needs_user` and prefers `blocked`.
- Design node task prompts include Design Brief Mode and design source artifacts.
- Unit tests cover agent prompts and design packet / prepare defaults.
