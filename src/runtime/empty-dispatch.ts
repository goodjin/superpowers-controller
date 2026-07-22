import { hasRunningNodeRuns } from "../state/task-status"
import type { DispatchDecision } from "../router/dispatch-types"
import type { WorkflowState } from "../state/types"

const TERMINAL_OR_WAITING = new Set<WorkflowState["status"]>([
  "passed",
  "canceled",
  "blocked",
  "waiting_user",
  "waiting_controller_decision",
  "awaiting_design_approval",
  "awaiting_plan_approval",
  "intake",
])

/**
 * True when the dispatcher produced no next step, there is no running child,
 * and the workflow is still unfinished — callers must escalate to the controller.
 */
export function shouldEscalateEmptyDispatch(
  state: WorkflowState,
  decisions: DispatchDecision[],
): boolean {
  if (decisions.length > 0) return false
  if (hasRunningNodeRuns(state)) return false
  if (TERMINAL_OR_WAITING.has(state.status)) return false
  return true
}

export function emptyDispatchReason(state: WorkflowState): string {
  return `No runnable next step after phase ${state.current_phase ?? state.phase} (status=${state.status}). Returning to controller.`
}
