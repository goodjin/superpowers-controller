import type { QuestionOption, WorkflowState } from "../state/types"

export function isDesignForegroundPhase(phase: string): boolean {
  return phase === "design"
}

export function designForegroundSourceNode(state: WorkflowState) {
  const sourceID = state.pending_question?.source_node_id
  if (sourceID) {
    const node = state.node_runs.find((run) => run.id === sourceID)
    if (node && isDesignForegroundPhase(node.phase) && node.session_id) return node
  }
  if (state.status === "awaiting_design_approval") {
    return [...state.node_runs].reverse().find((run) => isDesignForegroundPhase(run.phase) && run.session_id)
  }
  return undefined
}

export function buildDesignForegroundQuestionPrompt(state: WorkflowState): string {
  const question = state.pending_question
  if (!question) {
    return [
      "# Superpowers design waiting for user input",
      "",
      `Run: ${state.id}`,
      "",
      "The workflow is waiting_user, but no pending_question is available. Ask the user to check sp_status with the controller.",
    ].join("\n")
  }
  return [
    "# Superpowers design waiting for user input",
    "",
    `Run: ${state.id}`,
    `Phase: ${state.current_phase}`,
    `Source node: ${question.source_node_id ?? "unknown"}`,
    "",
    "Ask the user this pending_question in this design session. Do not answer it yourself.",
    "After you ask, stop and wait for the user reply in this same session.",
    "Do not call sp_start. The plugin resumes this node when the user replies here.",
    "",
    "## Question",
    question.prompt,
    "",
    question.options?.length ? "## Options" : "",
    question.options?.map((option) => `- ${option.label}${option.description ? `: ${option.description}` : ""}`).join("\n") ?? "",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

export function buildDesignCandidateReviewPrompt(state: WorkflowState): string {
  const question = state.pending_question
  return [
    "# Superpowers design candidate ready for review",
    "",
    `Run: ${state.id}`,
    `Workflow: ${state.workflow}`,
    "",
    "The candidate design/spec is ready. Summarize the candidate for the user in this design session,",
    "then ask whether to approve it, revise it, or cancel.",
    "Do not approve or revise on the user's behalf.",
    "If the user wants revisions, continue the design conversation in this session and call sp_report again when ready.",
    "If the user clearly approves, acknowledge briefly and stop. Do not call sp_start; the plugin will hand off to the controller.",
    "If the user wants to cancel, tell them the controller can cancel the workflow.",
    "",
    question?.prompt ? "## Pending review prompt" : "",
    question?.prompt ?? "",
    question?.options?.length ? "" : "",
    question?.options?.length ? "## Options" : "",
    question?.options?.map((option) => `- ${option.label}${option.description ? `: ${option.description}` : ""}`).join("\n") ?? "",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

export function buildDesignApprovalHandoffPrompt(state: WorkflowState, userMessage: string): string {
  return [
    "# Superpowers design approval handoff",
    "",
    `Run: ${state.id}`,
    `Workflow: ${state.workflow}`,
    `Phase: ${state.current_phase}`,
    "",
    "The user already approved the candidate design in the design child session.",
    "Do not ask for approval again.",
    "Proceed with the v5 confirmation path: sp_prepare if needed, then sp_start(start_prepared_task) with confirmation,",
    "or an allowed resolve_controller_decision. Keep the user in this parent controller session.",
    "",
    "## User approval message",
    userMessage,
    "",
    "```json",
    JSON.stringify({
      run_id: state.id,
      note: "User approved in design session; continue start_prepared_task / confirmation without re-asking.",
    }, null, 2),
    "```",
  ].join("\n")
}

export function looksLikeDesignApproval(text: string, options?: QuestionOption[]): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  const selected = matchApproveOptions(trimmed, options)
  if (selected.some((label) => /start_confirmed|approve|同意|通过|确认/i.test(label))) return true
  return /^(approve|approved|lgtm|ship\s*it|同意|可以|没问题|通过|确认|就这样|好的，就这样)([.。!！\s]|$)/i.test(trimmed)
}

function matchApproveOptions(answerText: string, options: QuestionOption[] | undefined): string[] {
  if (!options?.length) return []
  const trimmed = answerText.trim()
  const letter = trimmed.match(/^([A-Za-z])(?:[.)\s]|$)/)?.[1]?.toUpperCase()
  if (letter) {
    const index = letter.charCodeAt(0) - 65
    if (index >= 0 && index < options.length) return [options[index]!.label]
  }
  const numeric = trimmed.match(/^(\d+)(?:[.)\s]|$)/)?.[1]
  if (numeric) {
    const index = Number(numeric) - 1
    if (index >= 0 && index < options.length) return [options[index]!.label]
  }
  const lower = trimmed.toLowerCase()
  return options
    .filter((option) => {
      const label = option.label.trim().toLowerCase()
      return label === lower || lower.startsWith(label) || label.startsWith(lower)
    })
    .map((option) => option.label)
}
