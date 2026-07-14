import { buildControllerFeedback } from "../controller/feedback"
import type { ProgressReporter } from "../progress/reporter"
import type { SessionOrchestrator } from "../session/orchestrator"
import { buildControllerDecisionPrompt, buildSilentExitControllerPrompt } from "../session/templates"
import type { ProjectStore } from "../state/store"
import type { WorkflowState } from "../state/types"
import type { SilentExitEvidence } from "./silent-exit"

export async function notifyParentControllerDecision(args: {
  store: ProjectStore
  orchestrator: Pick<SessionOrchestrator, "notifyParent">
  progress?: ProgressReporter
  state: WorkflowState
  silentExit?: SilentExitEvidence & { artifact_path?: string }
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (args.state.status !== "waiting_controller_decision") {
    return { ok: false, error: `workflow status is ${args.state.status}` }
  }
  const parentSessionID = args.state.parent_session_id
  if (!parentSessionID) return { ok: false, error: "missing parent_session_id" }

  const feedback = buildControllerFeedback(args.state)
  const prompt = args.silentExit
    ? buildSilentExitControllerPrompt(args.state, {
        evidence: args.silentExit,
        artifact_path: args.silentExit.artifact_path,
        allowed_controller_decisions: feedback.allowed_controller_decisions,
      })
    : buildControllerDecisionPrompt(args.state, feedback.allowed_controller_decisions)

  try {
    await args.orchestrator.notifyParent({
      sessionID: parentSessionID,
      agent: "superpowers-agent",
      prompt,
      selectSession: true,
    })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    args.store.recordAuditEvent({
      event: "controller_decision_notification_failed",
      summary: message,
    })
    await args.progress?.report({
      stage: "workflow_blocked",
      title: "Superpowers workflow",
      message: `Parent controller decision notification failed: ${message}`,
      variant: "error",
    })
    return { ok: false, error: message }
  }
}
