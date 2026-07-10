import type { SpRecordInput, WorkflowState } from "../state/types"
import { decideFromWorkflowSpec } from "./workflow-spec-dispatch"

export type { DispatchDecision, ReviewContext } from "./dispatch-types"

export function decideNextDispatches(state: WorkflowState, record?: SpRecordInput) {
  return decideFromWorkflowSpec(state, record)
}
