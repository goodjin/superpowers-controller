import type { NodeRun, WorkflowState } from "../state/types"
import { hasRunningNodeRuns } from "../state/task-status"

const ATTENTION_NODE_STATUSES = new Set<NodeRun["status"]>([
  "dispatch_failed",
  "interrupted",
  "failed",
  "blocked",
  "notification_failed",
  "needs_user",
])

export type ParallelContext = {
  failed_nodes: Array<{ node_id: string; task_id?: string; session_id: string; status: NodeRun["status"] }>
  running_nodes: Array<{ node_id: string; task_id?: string; session_id: string }>
  blocked_downstream: string[]
}

export function hasRunningSiblings(state: WorkflowState, node: NodeRun): boolean {
  return state.node_runs.some((run) => run.id !== node.id && run.status === "running")
}

export function latestAttentionNode(state: WorkflowState): NodeRun | undefined {
  return [...state.node_runs].reverse().find((node) => {
    if (node.status === "running") return false
    return ATTENTION_NODE_STATUSES.has(node.status)
  })
}

export function needsControllerAttention(state: WorkflowState): boolean {
  if (["waiting_controller_decision", "recovered_unknown", "waiting_user_decision", "blocked", "failed"].includes(state.status)) {
    return true
  }
  const attention = latestAttentionNode(state)
  return Boolean(attention && (hasRunningSiblings(state, attention) || state.status === "running"))
}

export function workflowStatusAfterNodeFailure(
  current: WorkflowState,
  nodeRuns: NodeRun[],
): WorkflowState["status"] {
  if (nodeRuns.some((run) => run.status === "running")) {
    return current.status === "intake" ? "intake" : "running"
  }
  if (current.status === "recovered_unknown") return "recovered_unknown"
  return "waiting_controller_decision"
}

export function resolveWorkflowStatusAfterNodeReport(
  state: WorkflowState,
  nodeID: string,
  recordStatus: string,
): WorkflowState["status"] {
  if (recordStatus === "progress" || recordStatus === "needs_user") return state.status
  if (recordStatus !== "failed" && recordStatus !== "blocked") {
    if (recordStatus === "passed" && state.status === "waiting_controller_decision" && hasRunningNodeRuns(state)) {
      return "running"
    }
    return state.status
  }

  const nodeRuns = state.node_runs
  const hasOtherRunning = nodeRuns.some((run) => run.id !== nodeID && run.status === "running")
  if (hasOtherRunning) return "running"
  if (state.status === "recovered_unknown") return "recovered_unknown"
  return "waiting_controller_decision"
}

export function sessionErrorNodeStatus(errorMessage: string): NodeRun["status"] {
  const normalized = errorMessage.toLowerCase()
  if (normalized.includes("401") || normalized.includes("unauthorized") || normalized.includes("model_not_found") || normalized.includes("model not found")) {
    return "failed"
  }
  return "interrupted"
}

export function buildParallelContext(state: WorkflowState): ParallelContext | undefined {
  const failedNodes = state.node_runs.filter((node) =>
    ["failed", "dispatch_failed", "interrupted", "blocked", "notification_failed"].includes(node.status),
  )
  const runningNodes = state.node_runs.filter((node) => node.status === "running")
  if (failedNodes.length === 0) return undefined

  const blockedDownstream: string[] = []
  for (const failed of failedNodes) {
    if (!failed.task_id) continue
    const dependents = state.task_graph?.tasks.filter((task) => task.depends_on.includes(failed.task_id!)) ?? []
    for (const dependent of dependents) blockedDownstream.push(dependent.id)
  }

  return {
    failed_nodes: failedNodes.map((node) => ({
      node_id: node.id,
      task_id: node.task_id,
      session_id: node.session_id,
      status: node.status,
    })),
    running_nodes: runningNodes.map((node) => ({
      node_id: node.id,
      task_id: node.task_id,
      session_id: node.session_id,
    })),
    blocked_downstream: [...new Set(blockedDownstream)],
  }
}
