import { buildControllerFeedback } from "../controller/feedback"
import type { ProgressReporter } from "../progress/reporter"
import type { SessionOrchestrator } from "../session/orchestrator"
import { buildControllerDecisionPrompt, buildSilentExitControllerPrompt } from "../session/templates"
import type { ProjectStore } from "../state/store"
import type { WorkflowState } from "../state/types"
import type { SilentExitEvidence } from "./silent-exit"
import { needsControllerAttention } from "./workflow-attention"

export async function notifyParentControllerDecision(args: {
  store: ProjectStore
  orchestrator: Pick<SessionOrchestrator, "notifyParent"> & Partial<Pick<SessionOrchestrator, "returnToParent">>
  progress?: ProgressReporter
  state: WorkflowState
  silentExit?: SilentExitEvidence & { artifact_path?: string }
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // Parallel runs may keep workflow `running` after one node silent-exits.
  // Still hand off to the controller whenever attention is required.
  if (!needsControllerAttention(args.state)) {
    return { ok: false, error: `workflow status is ${args.state.status}` }
  }
  const parentSessionID = args.state.parent_session_id
  if (!parentSessionID) return { ok: false, error: "missing parent_session_id" }

  const siblingsStillRunning = args.state.status === "running" || args.state.status === "intake"

  // Always try to leave the child route first so the user sees the controller reaction,
  // even when the follow-up parent prompt fails to schedule.
  if (args.orchestrator.returnToParent) {
    await args.orchestrator.returnToParent({
      sessionID: parentSessionID,
      message: args.silentExit
        ? siblingsStillRunning
          ? "子会话异常结束，已切回主控。其它任务仍在跑。"
          : "子会话异常结束，已切回主控。"
        : "需要主控接手，已切回主控。",
    })
  }

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
      // returnToParent already focused the controller when available.
      selectSession: args.orchestrator.returnToParent ? false : true,
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
