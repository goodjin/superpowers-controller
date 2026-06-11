import { MODE_DEFINITIONS } from "../router/modes"

export type AgentConfigRecord = Record<string, Record<string, unknown>>

const RECORD_RULE = "Before ending the node, call sp_record with artifacts, evidence, and requested gate updates. Do not claim completion without verification_fresh."

const AGENT_PURPOSES: Record<string, string> = {
  "sp-designer": "Create design artifacts and wait for user approval before implementation.",
  "sp-planner": "Create implementation plan artifacts from approved specs.",
  "sp-debugger": "Investigate symptoms and record root cause before repair.",
  "sp-implementer": "Execute planned tasks with TDD and record red test and patch evidence.",
  "sp-spec-reviewer": "Check implemented work against spec and plan.",
  "sp-code-reviewer": "Review risks, regressions, quality, and missing tests.",
  "sp-verifier": "Run fresh verification and record command evidence.",
  "sp-finisher": "Prepare delivery, branch finish, PR, or commit decision after verification.",
}

const AUXILIARY_AGENT_SKILLS: Record<string, string[]> = {
  "sp-spec-reviewer": ["superpowers-requesting-code-review"],
  "sp-finisher": MODE_DEFINITIONS["verify-finish"].skills,
}

export function createAgentConfig(): AgentConfigRecord {
  const agentSkills = createAgentSkillMap()
  return {
    superpowers: {
      description: "Controller for Superpowers workflow routing and state.",
      mode: "primary",
      color: "accent",
      permission: {
        edit: "deny",
        bash: "ask",
        task: {
          "*": "deny",
          "sp-*": "allow",
        },
      },
      prompt: [
        "You are Superpowers Controller for OpenCode.",
        "Use sp_route to classify requests, sp_state to inspect state, and sp_next to advance the active workflow.",
        "You do not directly implement code unless routed into an implementation node.",
        "For parallel-investigate, dispatch independent sp-* subagents only after recording the independence proof and shared-write conflict check.",
      ].join("\n"),
    },
    "sp-designer": nodeAgent("Design node", agentSkills["sp-designer"], AGENT_PURPOSES["sp-designer"], "subagent"),
    "sp-planner": nodeAgent("Plan node", agentSkills["sp-planner"], AGENT_PURPOSES["sp-planner"], "subagent"),
    "sp-debugger": nodeAgent("Debug node", agentSkills["sp-debugger"], AGENT_PURPOSES["sp-debugger"], "subagent"),
    "sp-implementer": nodeAgent("Implementation node", agentSkills["sp-implementer"], AGENT_PURPOSES["sp-implementer"], "subagent"),
    "sp-spec-reviewer": nodeAgent("Spec review node", agentSkills["sp-spec-reviewer"], AGENT_PURPOSES["sp-spec-reviewer"], "subagent"),
    "sp-code-reviewer": nodeAgent("Code review node", agentSkills["sp-code-reviewer"], AGENT_PURPOSES["sp-code-reviewer"], "subagent"),
    "sp-verifier": nodeAgent("Verification node", agentSkills["sp-verifier"], AGENT_PURPOSES["sp-verifier"], "subagent"),
    "sp-finisher": nodeAgent("Finish node", agentSkills["sp-finisher"], AGENT_PURPOSES["sp-finisher"], "subagent"),
  }
}

function createAgentSkillMap(): Record<string, string[]> {
  const map: Record<string, string[]> = { ...AUXILIARY_AGENT_SKILLS }
  for (const definition of Object.values(MODE_DEFINITIONS)) {
    if (definition.agent === "superpowers") continue
    map[definition.agent] = Array.from(new Set([...(map[definition.agent] ?? []), ...definition.skills]))
  }
  return map
}

function nodeAgent(description: string, skills: string[], purpose: string, mode: "primary" | "subagent" | "all"): Record<string, unknown> {
  return {
    description,
    mode,
    permission: {
      edit: "ask",
      bash: "ask",
      task: "ask",
    },
    prompt: [
      purpose,
      `Load and follow these skills for this node: ${skills.join(", ")}.`,
      RECORD_RULE,
    ].join("\n"),
  }
}
