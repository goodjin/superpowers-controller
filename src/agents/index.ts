import { AGENT_SKILL_MAP, type NodeAgentName } from "../router/modes"

export type AgentConfigRecord = Record<string, Record<string, unknown>>

const RECORD_RULE = [
  "Before ending the node, call sp_record with event, status, summary, artifacts, gates, checks, findings, question, or task_graph as relevant.",
  "Do not include next_action, target_session_id, child_session_id, reuse_session_id, create_sessions, or skills_used.",
  "The plugin owns workflow routing, session creation, session reuse, and retry decisions.",
].join(" ")

const AGENT_PURPOSES: Record<NodeAgentName, string> = {
  "sp-designer": "Design/spec node. Clarify the shape of the change and produce the spec artifact.",
  "sp-planner": "Planning node. Turn approved requirements into an implementation plan and a depends_on task graph.",
  "sp-debugger": "Debug node. Investigate symptoms and record the root cause before repair work starts.",
  "sp-investigator": "Investigation node. Read one independent problem domain and report findings without changing files.",
  "sp-implementer": "Implementation node. Execute one assigned task with TDD evidence and patch summary.",
  "sp-spec-reviewer": "Spec review node. Check whether the implementation satisfies the request, spec, and plan.",
  "sp-code-reviewer": "Code review node. Review regressions, quality risks, missing tests, and maintainability.",
  "sp-verifier": "Verification node. Run fresh verification commands and record command evidence.",
  "sp-finisher": "Finish node. Prepare final delivery only after verification has passed.",
}

export function createAgentConfig(): AgentConfigRecord {
  return {
    "super-agent": {
      description: "Primary controller for Superpowers workflow state and dispatch.",
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
      tools: {
        skill: false,
      },
      prompt: [
        "You are Superpowers Controller for OpenCode.",
        "Understand user intent, restore or create workflow state, ask for user confirmation, and create or reuse child sessions through plugin tools.",
        "Do not directly implement code, edit files, or perform node work.",
        "Do not load business or development skills. The controller has no primary skill; node agents load their own plugin-assigned primary skill.",
        "Use sp_route, sp_state, and sp_next to inspect state and advance the workflow.",
        "Progress messages should be reported through plugin state or TUI surfaces when available, not by adding noisy narrative to node prompts.",
      ].join("\n"),
    },
    ...Object.fromEntries(
      Object.entries(AGENT_SKILL_MAP).map(([agentName, primarySkill]) => [
        agentName,
        nodeAgent(agentName as NodeAgentName, primarySkill),
      ]),
    ),
  }
}

function nodeAgent(agentName: NodeAgentName, primarySkill: string): Record<string, unknown> {
  return {
    description: AGENT_PURPOSES[agentName],
    mode: "subagent",
    permission: {
      edit: agentName === "sp-investigator" || agentName.endsWith("reviewer") || agentName === "sp-verifier" ? "deny" : "ask",
      bash: "ask",
      task: "deny",
      skill: {
        "*": "deny",
        [primarySkill]: "allow",
      },
    },
    prompt: [
      AGENT_PURPOSES[agentName],
      `Primary skill: ${primarySkill}.`,
      "Load and follow the primary skill before doing node work.",
      "Use only this primary skill for the node unless the controller creates a different session for another node.",
      RECORD_RULE,
    ].join("\n"),
  }
}
