import type { SpRecordInput } from "../state/types"

export type ReviewContext = {
  source_event: SpRecordInput["event"]
  summary: string
  report?: string
}

export type DispatchDecision =
  | {
      action: "create_session"
      phase: string
      agent: import("./modes").NodeAgentName
      primary_skill: string
      task_id?: string
      review_context?: ReviewContext
      reason: string
    }
  | {
      action: "reuse_session"
      phase: string
      agent: import("./modes").NodeAgentName
      primary_skill: string
      session_id: string
      task_id?: string
      review_context?: ReviewContext
      reason: string
    }
  | {
      action: "wait_user"
      reason: string
    }
  | {
      action: "finish"
      reason: string
    }
  | {
      action: "blocked"
      reason: string
    }
