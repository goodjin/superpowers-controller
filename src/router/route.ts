import { classifyRequest } from "./classify"
import { modeDefinition } from "./modes"
import type { WorkflowState } from "../state/types"

export type RouteDecision = ReturnType<typeof modeDefinition> & {
  reason: string
}

export function routeWorkflow(args: {
  request: string
  command?: string
  currentState?: WorkflowState | null
}): RouteDecision {
  if (args.currentState && args.currentState.mode !== "idle" && isGateWaitingPhase(args.currentState.phase)) {
    return {
      ...modeDefinition(args.currentState.mode),
      phase: args.currentState.phase,
      reason: `active workflow is waiting in ${args.currentState.phase}`,
    }
  }

  const classification = classifyRequest(args.request, args.command)
  if (classification.confidence < 0.5) {
    return {
      ...modeDefinition("idle"),
      phase: "clarify",
      reason: classification.reason,
    }
  }

  return {
    ...modeDefinition(classification.mode),
    reason: classification.reason,
  }
}

function isGateWaitingPhase(phase: string): boolean {
  return /awaiting|waiting|approval|gate|review|verify/i.test(phase)
}
