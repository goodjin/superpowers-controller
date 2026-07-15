import type { ProgressReporter } from "../progress/reporter"
import type { ProjectStore } from "../state/store"
import type { QuestionOption, ResumeInput } from "../state/types"

export type ChildAnswerBridgeResult =
  | { bridged: false; reason: string }
  | { bridged: true; node_id: string; answer_text: string; selected_options?: string[] }

/**
 * When a user types into a child session that is waiting on needs_user,
 * consume the pending question so the control plane matches the chat reply.
 * Does not call resumeNode — the host already delivers this user message to the child.
 */
export function bridgeChildAnswerToPendingQuestion(args: {
  store: ProjectStore
  sessionID: string
  parts: ReadonlyArray<unknown>
  progress?: ProgressReporter
}): ChildAnswerBridgeResult {
  const text = extractUserText(args.parts).trim()
  if (!text) return { bridged: false, reason: "empty_user_text" }
  if (looksLikeControllerSyntheticPrompt(text)) {
    return { bridged: false, reason: "synthetic_controller_prompt" }
  }

  const state = args.store.readCurrent()
  if (!state) return { bridged: false, reason: "no_active_workflow" }
  if (state.status !== "waiting_user" || !state.pending_question?.source_node_id) {
    return { bridged: false, reason: "not_waiting_user" }
  }

  const node = state.node_runs.find((run) => run.id === state.pending_question?.source_node_id)
  if (!node || node.session_id !== args.sessionID) {
    return { bridged: false, reason: "session_not_pending_source" }
  }
  if (node.status !== "needs_user") {
    return { bridged: false, reason: `node_status_${node.status}` }
  }

  const selected_options = matchSelectedOptions(text, state.pending_question.options)
  const resumeInput: ResumeInput = {
    source_node_id: node.id,
    answer_text: text,
    user_message: text,
    ...(selected_options?.length ? { selected_options } : {}),
  }

  try {
    args.store.consumePendingQuestion({
      runID: state.id,
      parentSessionID: state.parent_session_id,
      resumeInput,
    })
  } catch (error) {
    return {
      bridged: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  void args.progress?.report({
    stage: "run_resumed",
    title: "Superpowers workflow",
    message: `Answer received in child session ${args.sessionID}; pending question for ${node.id} consumed.`,
    variant: "success",
  })

  return {
    bridged: true,
    node_id: node.id,
    answer_text: text,
    selected_options,
  }
}

export function extractUserText(parts: ReadonlyArray<unknown>): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== "object") continue
    const record = part as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string") {
      chunks.push(record.text)
      continue
    }
    if (typeof record.text === "string") chunks.push(record.text)
  }
  return chunks.join("\n").trim()
}

export function matchSelectedOptions(
  answerText: string,
  options: QuestionOption[] | undefined,
): string[] | undefined {
  if (!options?.length) return undefined
  const trimmed = answerText.trim()
  if (!trimmed) return undefined

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
  const byLabel = options.filter((option) => {
    const label = option.label.trim().toLowerCase()
    return label === lower || lower.startsWith(label) || label.startsWith(lower)
  })
  if (byLabel.length === 1) return [byLabel[0]!.label]
  return undefined
}

function looksLikeControllerSyntheticPrompt(text: string): boolean {
  return (
    text.startsWith("# Superpowers User Input Resume")
    || text.startsWith("# Superpowers workflow waiting for user input")
    || text.startsWith("# Superpowers Node Task:")
    || text.startsWith("# Superpowers workflow waiting for controller decision")
  )
}
