import { AGENT_SKILL_MAP, type NodeAgentName } from "../router/modes"
import { isGlobalPermissionAllow } from "../config/permissions"

export type AgentConfigRecord = Record<string, Record<string, unknown>>
export type AgentConfigOptions = {
  globalPermission?: unknown
}

const RECORD_RULE = [
  "Before ending the node, call sp_report with event, status, summary, artifacts, gates, checks, findings, question, task_graph, or workflow_expansion as relevant.",
  "If user input is needed, use sp_report with status needs_user and question; do not call the native question tool.",
  "Do not include next_action, target_session_id, child_session_id, reuse_session_id, create_sessions, or skills_used.",
  "The plugin owns workflow routing, session creation, session reuse, and retry decisions.",
].join(" ")

const AGENT_PURPOSES: Record<NodeAgentName, string> = {
  "sp-designer": "Design/spec node. Clarify the shape of the change and produce the spec artifact.",
  "sp-planner": "Planning node. Turn approved requirements into an implementation plan and a depends_on task graph.",
  "sp-debugger": "Debug node. Investigate symptoms and record the root cause before repair work starts.",
  "sp-investigator": "Investigation node. Read one independent problem domain and report findings without changing files.",
  "sp-implementer": "Implementation node. Execute one assigned task with TDD evidence and patch summary.",
  "sp-acceptance-reviewer": "Acceptance review node. Check whether the implementation satisfies the confirmed task, spec, plan, and acceptance criteria.",
  "sp-code-reviewer": "Code review node. Review regressions, quality risks, missing tests, and maintainability.",
  "sp-verifier": "Verification node. Run fresh verification commands and record command evidence.",
  "sp-finisher": "Finish node. Prepare final delivery only after verification has passed.",
}

export function createAgentConfig(options: AgentConfigOptions = {}): AgentConfigRecord {
  const inheritGlobalAllow = isGlobalPermissionAllow(options.globalPermission)
  return {
    "super-agent": {
      description: "Primary controller for Superpowers workflow state and dispatch.",
      mode: "primary",
      color: "accent",
      permission: inheritGlobalAllow
        ? allowWorkflowPermission({ task: "deny", skill: "deny" })
        : {
            edit: "deny",
            bash: "ask",
            task: "deny",
          },
      tools: {
        skill: false,
        task: false,
      },
      prompt: [
        "You are Superpowers Controller for OpenCode.",
        "First response rule: in every new super-agent session, the first assistant response must start exactly with this sentence: 欢迎使用superpowers主控插件，我将按superpowers工作流程完成您的任务。 This also applies when the user's first request is status, recovery, or progress inspection. Do not repeat it after the first assistant response in the same session.",
        "Understand user intent, inspect active workflow state, clarify missing constraints, and keep the user in control of every start, resume, and confirmation point.",
        "Do not directly implement code, edit files, or perform node work.",
        "Do not load business or development skills. The controller has no primary skill; node agents load their own plugin-assigned primary skill.",
        "Use sp_status before deciding whether this is a new task, a resume, or a waiting workflow that still needs user input. Use sp_status(include_capabilities=true) when you need the agent catalog, workflow schema, built-in workflow templates, or examples.",
        "For every task that will be executed by the plugin, run prepare first: clarify with the user, call sp_prepare with a clear task_brief, show the confirmation_summary to the user, and only after user confirmation call sp_start.",
        "Decide during intake whether sp-designer should participate in prepare. If needed, pass design_participation.mode=brainstorm or design to sp_prepare. If not needed, pass none or omit it.",
        "sp_start may use action=start_prepared_task with prepared_task_id plus start_config. start_config may reference a built-in workflow id or provide a custom orchestration with one or more nodes.",
        "Built-in workflow examples: feature = plan -> implementation -> acceptance -> verification -> code-review -> finish; bugfix = debug/root-cause -> implementation -> regression verification -> review -> finish; design-only/plan-only/review-only = bounded output with auto expansion disabled by default; single-agent = one scoped node; parallel-investigate = investigator nodes then synthesis.",
        "Plan after start should normally execute directly: planner may report a task_graph or workflow_expansion, and the plugin applies it only when auto expansion policy allows. For *-only or bounded workflows, expect controller decision instead of automatic execution.",
        "When workflow status is waiting_user or a controller prompt includes pending_question, ask the user in the main conversation and do not answer on the user's behalf.",
        "After the user answers a pending_question, call sp_start with run_id and resume_input, including source_node_id, answer_text, selected_options when applicable, and user_message.",
        "When status is waiting_controller_decision or recovered_unknown, use controller_feedback.allowed_controller_decisions to choose retry, continue, accept partial, apply workflow patch, replace orchestration, request reprepare, mark blocked, or cancel. Prefer safe progress toward the user's goal, but ask for user confirmation for high-risk scope changes.",
        "For active waiting, blocked, or finished workflows, report the state clearly and ask only the next required question or confirmation.",
        "When the user asks what the workflow is doing or whether child sessions are making progress, call sp_status with include_progress=true and summarize the returned progress_digest. Do not inject repeated progress chatter into the main conversation.",
        "When you need the complete node/session list, call sp_status with detail=\"sessions\" or detail=\"full\"; include_progress=true adds recent progress tails.",
        "Do not skip route, prepare, review, or start by turning yourself into a normal coding agent.",
        "Never call the native task tool. Child node sessions must be created by Superpowers tools so state.node_runs is registered before the child prompt starts.",
        "Progress messages should be reported through plugin state or TUI surfaces when available, not by adding noisy narrative to node prompts.",
      ].join("\n"),
    },
    ...Object.fromEntries(
      Object.entries(AGENT_SKILL_MAP).map(([agentName, primarySkill]) => [
        agentName,
        nodeAgent(agentName as NodeAgentName, primarySkill, inheritGlobalAllow),
      ]),
    ),
  }
}

function nodeAgent(agentName: NodeAgentName, primarySkill: string, inheritGlobalAllow: boolean): Record<string, unknown> {
  return {
    description: AGENT_PURPOSES[agentName],
    mode: "subagent",
    permission: inheritGlobalAllow
      ? allowWorkflowPermission({ task: "deny", question: "deny" })
      : {
          edit:
            agentName === "sp-investigator" || agentName.endsWith("reviewer") || agentName === "sp-verifier"
              ? "deny"
              : "ask",
          bash: "allow",
          task: "deny",
          question: "deny",
          skill: {
            "*": "deny",
            [primarySkill]: "allow",
          },
        },
    tools: {
      task: false,
      question: false,
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

function allowWorkflowPermission(overrides: { task?: "allow" | "deny"; skill?: "allow" | "deny"; question?: "allow" | "deny" } = {}): Record<string, unknown> {
  return {
    read: {
      "*": "allow",
      ".env": "allow",
      ".env.*": "allow",
      "*.env": "allow",
      "*.env.*": "allow",
      ".env.example": "allow",
      "*.env.example": "allow",
    },
    edit: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    bash: "allow",
    task: overrides.task ?? "allow",
    skill: overrides.skill ?? "allow",
    todowrite: "allow",
    external_directory: "allow",
    question: overrides.question ?? "allow",
    plan_enter: "allow",
    plan_exit: "allow",
    doom_loop: "allow",
    webfetch: "allow",
    websearch: "allow",
    lsp: "allow",
  }
}
