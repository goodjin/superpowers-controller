import { modeDefinition } from "../router/modes"
import type { WorkflowState } from "../state/types"

const MARKER = "<superpowers-controller-runtime>"

export function buildRuntimeSkillInjection(state: WorkflowState): string {
  const definition = modeDefinition(state.mode)
  const [primarySkill, ...supportingSkills] = definition.skills
  return [
    MARKER,
    `run: ${state.id}`,
    `mode: ${state.mode}`,
    `phase: ${state.phase}`,
    `agent: ${definition.agent}`,
    `primary_skill: ${primarySkill ?? "none"}`,
    `supporting_skills: ${supportingSkills.length > 0 ? supportingSkills.join(", ") : "none"}`,
    "",
    "Skill loading policy:",
    "- Load and follow the primary skill before doing node work.",
    "- Prefer one primary skill per session.",
    "- If supporting skills require substantial independent work, create or route a separate subagent session for that skill.",
    "- End the node by calling sp_report with event, status, summary, artifacts, gates, checks, findings, question, or task_graph as relevant.",
    '- For needs_user reports, question.options uses objects: [{ "label": "...", "description": "..." }].',
    "- Do not include next_action, target_session_id, child_session_id, reuse_session_id, create_sessions, or skills_used.",
    `${MARKER.replace("<", "</")}`,
  ].join("\n")
}

export function hasRuntimeSkillInjection(value: string): boolean {
  return value.includes(MARKER)
}
