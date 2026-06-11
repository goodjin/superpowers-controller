import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { modeDefinition } from "../router/modes"
import { buildRuntimeSkillInjection } from "../skills/runtime-injection"
import type { ProjectStore } from "../state/store"

export function createNextTool(store: ProjectStore): ToolDefinition {
  return tool({
    description: "Return the next prompt for the active Superpowers workflow.",
    args: {},
    async execute() {
      const state = store.readCurrent()
      if (!state) return "No active Superpowers workflow. Call sp_route first."
      const mode = modeDefinition(state.mode)
      const [primarySkill, ...supportingSkills] = mode.skills
      return JSON.stringify(
        {
          run: state.id,
          mode: state.mode,
          phase: state.phase,
          agent: mode.agent,
          skills: mode.skills,
          primary_skill: primarySkill ?? null,
          supporting_skills: supportingSkills,
          session_policy: "Prefer one primary skill per session; create or route a separate subagent session for substantial supporting-skill work.",
          runtime_injection: buildRuntimeSkillInjection(state),
          gates: state.gates,
          next: state.next ?? mode.next,
        },
        null,
        2,
      )
    },
  })
}
