import type { ControllerDecision, ControllerDecisionKind, NodeRun, StartAction, WorkflowState } from "../state/types"
import {
  buildParallelContext,
  latestAttentionNode,
  needsControllerAttention,
  type ParallelContext,
} from "../runtime/workflow-attention"
import { STALLED_PROGRESS_AFTER_MS } from "../tui/progress-panel"

export type RecommendedNext =
  | { action: "wait_running_node"; run_id: string; node_id: string; session_id: string }
  | { action: "answer_pending_question"; run_id: string; node_id?: string }
  | { action: "approve_proposal"; run_id: string }
  | { action: "start_confirmed_task"; run_id: string }
  | { action: "request_reprepare"; run_id: string }
  | { action: "revise_request"; run_id: string }
  | { action: "revise_design"; run_id: string }
  | { action: "retry_dispatch"; run_id: string; node_id: string }
  | { action: "retry_node"; run_id: string; task_id?: string; phase: string }
  | { action: "cancel_node"; run_id: string; node_id: string }
  | { action: "cancel_workflow"; run_id: string }
  | { action: "revise_plan"; run_id: string }
  | { action: "finish"; run_id: string }
  | { action: "blocked"; reason: string }

export type ControllerFeedback = {
  outcome: "ok" | "waiting" | "needs_user" | "needs_approval" | "blocked" | "failed" | "terminal"
  state_version: string
  run_id?: string
  current_status: WorkflowState["status"]
  current_phase: string
  recommended_next: RecommendedNext[]
  allowed_controller_decisions: AllowedControllerDecision[]
  allowed_tool_calls: Array<"sp_status" | "sp_prepare" | "sp_start" | "sp_cancel" | "sp_report">
  requires_user?: {
    reason: string
    question?: string
    options?: Array<{ label: string; description?: string }>
  }
  approval_target?: "design" | "plan" | "retry" | "cancel"
  autonomous_options?: Array<{
    action: string
    when_safe: string
    risk: "low" | "medium" | "high"
  }>
  blocking_reason?: string
  artifact_mode?: "candidate" | "canonical" | "none"
  parallel_context?: ParallelContext
  inspection_hints?: Array<{
    tool: "sp_status"
    args: Record<string, unknown>
    reason: string
  }>
  permission_context?: { session_id: string; hint: string }
  stall_context?: { node_id: string; session_id: string; idle_ms: number }
}

export type AllowedControllerDecision = {
  kind: ControllerDecisionKind
  reason: string
  risk: "low" | "medium" | "high"
  tool: "sp_status" | "sp_prepare" | "sp_start" | "sp_cancel"
  payload: Record<string, unknown>
  requires_user_confirmation?: boolean
}

export function buildRecommendedNext(state: WorkflowState): RecommendedNext[] {
  const parallel = buildParallelContext(state)
  const attention = latestAttentionNode(state)
  if (parallel && parallel.running_nodes.length > 0 && attention) {
    const running = state.node_runs.find((node) => node.id === parallel.running_nodes[0]?.node_id)
    return [
      { action: "retry_node", run_id: state.id, task_id: attention.task_id, phase: attention.phase },
      ...(running ? [{ action: "wait_running_node" as const, run_id: state.id, node_id: running.id, session_id: running.session_id }] : []),
      { action: "cancel_workflow", run_id: state.id },
    ]
  }

  const running = state.node_runs.find((node) => node.status === "running")
  if (running) {
    return [{ action: "wait_running_node", run_id: state.id, node_id: running.id, session_id: running.session_id }]
  }
  if (state.status === "waiting_user" && state.pending_question) {
    return [{ action: "answer_pending_question", run_id: state.id, node_id: state.pending_question.source_node_id }]
  }
  if (state.status === "awaiting_design_approval") {
    return [{ action: "start_confirmed_task", run_id: state.id }, { action: "request_reprepare", run_id: state.id }, { action: "revise_design", run_id: state.id }, { action: "cancel_workflow", run_id: state.id }]
  }
  if (state.status === "awaiting_plan_approval") {
    return [{ action: "start_confirmed_task", run_id: state.id }, { action: "request_reprepare", run_id: state.id }, { action: "revise_plan", run_id: state.id }, { action: "cancel_workflow", run_id: state.id }]
  }
  if (state.activation === "draft" && state.prepare_mode === "proposal_only") {
    return [{ action: "approve_proposal", run_id: state.id }, { action: "revise_request", run_id: state.id }, { action: "cancel_workflow", run_id: state.id }]
  }
  const dispatchFailed = [...state.node_runs].reverse().find((node) => node.status === "dispatch_failed")
  if (dispatchFailed) {
    return [
      { action: "retry_node", run_id: state.id, task_id: dispatchFailed.task_id, phase: dispatchFailed.phase },
      { action: "cancel_node", run_id: state.id, node_id: dispatchFailed.id },
      { action: "cancel_workflow", run_id: state.id },
    ]
  }
  const interrupted = [...state.node_runs].reverse().find((node) => node.status === "interrupted")
  if (interrupted) {
    return [
      { action: "retry_node", run_id: state.id, task_id: interrupted.task_id, phase: interrupted.phase },
      { action: "cancel_node", run_id: state.id, node_id: interrupted.id },
      { action: "cancel_workflow", run_id: state.id },
    ]
  }
  if (state.status === "passed") return [{ action: "finish", run_id: state.id }]
  if (state.status === "canceled") return [{ action: "blocked", reason: "workflow is canceled" }]
  if (state.status === "blocked" || state.status === "failed" || state.status === "waiting_user_decision" || state.status === "waiting_controller_decision" || state.status === "recovered_unknown") {
    return [{ action: "blocked", reason: `workflow is ${state.status}` }]
  }
  return [{ action: "blocked", reason: "no runnable node or approval decision is available" }]
}

export function buildAllowedControllerDecisions(state: WorkflowState): AllowedControllerDecision[] {
  if (state.status === "passed" || state.status === "canceled") return []
  if (state.status === "waiting_user") return []

  if ((state.status === "running" || state.status === "intake") && !needsControllerAttention(state)) {
    return []
  }

  const decisions: AllowedControllerDecision[] = []
  const failedNode = latestDecisionNode(state)
  if (failedNode) {
    decisions.push(decisionOption(state, {
      kind: "retry_node",
      node_id: failedNode.id,
      task_id: failedNode.task_id,
      reason: `Retry ${failedNode.phase} node ${failedNode.id}.`,
    }, {
      reason: `Retry the latest ${failedNode.status} node with a fresh child session.`,
      risk: failedNode.status === "interrupted" || failedNode.status === "dispatch_failed" ? "medium" : "high",
      tool: "sp_start",
      requiresUserConfirmation: true,
    }))
  }

  if (state.status === "waiting_controller_decision" && state.pending_workflow_expansion) {
    decisions.push(decisionOption(state, {
      kind: "apply_workflow_patch",
      workflow_patch: state.pending_workflow_expansion,
      reason: state.pending_workflow_expansion.reason ?? "Apply pending workflow expansion after controller review.",
    }, {
      reason: "Apply the pending node-reported workflow expansion.",
      risk: "medium",
      tool: "sp_start",
      requiresUserConfirmation: true,
    }))
  }

  if (state.status === "waiting_user_decision" || state.status === "waiting_controller_decision" || (state.status === "running" && failedNode && buildParallelContext(state)?.running_nodes.length)) {
    decisions.push(decisionOption(state, {
      kind: "continue_existing_graph",
      reason: "Continue by recalculating runnable nodes from the current graph.",
    }, {
      reason: "Ask runtime to continue from current structured state without changing scope.",
      risk: "medium",
      tool: "sp_start",
      requiresUserConfirmation: true,
    }))
  }

  const evidenceRefs = partialEvidenceRefs(failedNode)
  if (evidenceRefs.length > 0) {
    decisions.push(decisionOption(state, {
      kind: "accept_partial_result",
      node_id: failedNode?.id,
      task_id: failedNode?.task_id,
      evidence_refs: evidenceRefs,
      reason: "Accept available reported output as the final partial result.",
    }, {
      reason: "Finish the workflow with an explicit partial-result history entry.",
      risk: "high",
      tool: "sp_start",
      requiresUserConfirmation: true,
    }))
  }

  decisions.push(decisionOption(state, {
    kind: "mark_blocked",
    reason: `Controller decided not to continue while workflow is ${state.status}.`,
    required_user_action: "Review the blocked workflow state and provide a revised instruction.",
  }, {
    reason: "Stop automatic progress and persist the workflow as blocked.",
    risk: state.status === "blocked" ? "low" : "medium",
    tool: "sp_start",
    requiresUserConfirmation: true,
  }))

  decisions.push(decisionOption(state, {
    kind: "request_reprepare",
    reason: "The existing workflow cannot safely continue; prepare a revised task before restarting.",
  }, {
    reason: "Persist that the controller should return to sp_prepare for a revised task.",
    risk: "medium",
    tool: "sp_start",
    requiresUserConfirmation: true,
  }))

  return decisions
}

export function buildControllerFeedback(state: WorkflowState, override?: Partial<ControllerFeedback>): ControllerFeedback {
  const parallelContext = buildParallelContext(state)
  const recommendedNext = override?.recommended_next ?? buildRecommendedNext(state)
  const needsApproval = state.status === "awaiting_design_approval" || state.status === "awaiting_plan_approval"
  const waitingUser = state.status === "waiting_user"
  const terminal = state.status === "passed" || state.status === "canceled"
  const attention = needsControllerAttention(state)
  const blocked = state.status === "blocked" || state.status === "waiting_user_decision" || state.status === "waiting_controller_decision" || state.status === "recovered_unknown" || attention
  const stalled = stalledRunningNode(state)
  return {
    outcome: override?.outcome ?? (
      terminal ? "terminal" :
      state.status === "failed" ? "failed" :
      needsApproval ? "needs_approval" :
      waitingUser ? "needs_user" :
      blocked ? "blocked" :
      recommendedNext.some((next) => next.action === "wait_running_node") ? "waiting" :
      "ok"
    ),
    state_version: stateVersion(state),
    run_id: state.id,
    current_status: state.status,
    current_phase: state.current_phase,
    recommended_next: recommendedNext,
    allowed_controller_decisions: override?.allowed_controller_decisions ?? buildAllowedControllerDecisions(state),
    allowed_tool_calls: override?.allowed_tool_calls ?? ["sp_status", "sp_prepare", "sp_start", "sp_cancel", "sp_report"],
    requires_user: override?.requires_user ?? userRequirementForState(state),
    approval_target: override?.approval_target ?? approvalTargetForState(state),
    autonomous_options: override?.autonomous_options,
    blocking_reason: override?.blocking_reason ?? blockingReasonForState(state, parallelContext, stalled),
    artifact_mode: override?.artifact_mode ?? artifactModeForState(state),
    parallel_context: override?.parallel_context ?? parallelContext,
    inspection_hints: override?.inspection_hints ?? inspectionHintsForState(state, stalled),
    permission_context: override?.permission_context,
    stall_context: stalled ? {
      node_id: stalled.node_id,
      session_id: stalled.session_id,
      idle_ms: stalled.idle_ms,
    } : override?.stall_context,
  }
}

export function staleStateFeedback(state: WorkflowState, expected: string): ControllerFeedback {
  return buildControllerFeedback(state, {
    outcome: "blocked",
    blocking_reason: `expected_state_version ${expected} is stale; current state_version is ${stateVersion(state)}.`,
    allowed_tool_calls: ["sp_status", "sp_start", "sp_cancel"],
  })
}

export function stateVersion(state: WorkflowState): string {
  return state.state_version ?? `${state.updated_at}:legacy`
}

export function inferStartAction(state: WorkflowState, args: { start_action?: StartAction; resume_input?: unknown; task_id?: string }): StartAction {
  if (args.start_action) return args.start_action
  if (args.resume_input) return "resume_user_input"
  if (state.status === "awaiting_design_approval" || state.status === "awaiting_plan_approval") return "resolve_controller_decision"
  if (state.status === "recovered_unknown" && args.task_id) return "retry_node"
  return "start_prepared_task"
}

function userRequirementForState(state: WorkflowState): ControllerFeedback["requires_user"] {
  if (state.status === "waiting_user" && state.pending_question) {
    return {
      reason: "A node requested user input.",
      question: state.pending_question.prompt,
      options: state.pending_question.options,
    }
  }
  if (state.status === "awaiting_design_approval") return { reason: "Candidate design requires a v5 controller decision or a revised sp_prepare -> sp_start(start_prepared_task) path." }
  if (state.status === "awaiting_plan_approval") return { reason: "Candidate plan requires a v5 controller decision or a revised sp_prepare -> sp_start(start_prepared_task) path." }
  if (state.status === "waiting_user_decision") return { reason: "Controller needs a retry, cancel, approve, or revise decision." }
  if (state.status === "waiting_controller_decision") return { reason: "Controller needs to apply, replace, retry, block, reprepare, or cancel." }
  return undefined
}

function approvalTargetForState(state: WorkflowState): ControllerFeedback["approval_target"] {
  if (state.status === "awaiting_design_approval") return "design"
  if (state.status === "awaiting_plan_approval") return "plan"
  if (state.status === "recovered_unknown" || state.status === "waiting_user_decision" || state.status === "waiting_controller_decision") return "retry"
  return undefined
}

function artifactModeForState(state: WorkflowState): ControllerFeedback["artifact_mode"] {
  if (state.status === "awaiting_design_approval" || state.status === "awaiting_plan_approval") return "candidate"
  if (state.artifacts.spec || state.artifacts.plan || state.task_graph) return "canonical"
  return "none"
}

function latestDecisionNode(state: WorkflowState): NodeRun | undefined {
  return [...state.node_runs].reverse().find((node) => {
    if (node.status === "running") return false
    return ["dispatch_failed", "interrupted", "failed", "blocked", "notification_failed", "needs_user"].includes(node.status)
  })
}

function partialEvidenceRefs(node: NodeRun | undefined): string[] {
  if (!node?.record_path) return []
  return [node.record_path]
}

function decisionOption(
  state: WorkflowState,
  decision: ControllerDecision,
  meta: {
    reason: string
    risk: AllowedControllerDecision["risk"]
    tool: AllowedControllerDecision["tool"]
    requiresUserConfirmation?: boolean
  },
): AllowedControllerDecision {
  return {
    kind: decision.kind,
    reason: meta.reason,
    risk: meta.risk,
    tool: meta.tool,
    payload: {
      run_id: state.id,
      start_action: "resolve_controller_decision",
      expected_state_version: stateVersion(state),
      controller_decision: decision,
    },
    requires_user_confirmation: meta.requiresUserConfirmation,
  }
}

function blockingReasonForState(
  state: WorkflowState,
  parallel: ParallelContext | undefined,
  stalled: { node_id: string; session_id: string; idle_ms: number } | undefined,
): string | undefined {
  if (parallel && parallel.running_nodes.length > 0 && parallel.failed_nodes.length > 0) {
    return `Parallel workflow has ${parallel.failed_nodes.length} failed node(s) while ${parallel.running_nodes.length} node(s) are still running.`
  }
  if (state.status === "waiting_controller_decision") return "Controller needs to apply, replace, retry, block, reprepare, or cancel."
  if (state.status === "recovered_unknown") return "Startup recovery found previously running nodes that may no longer be live."
  if (stalled) return `Running node ${stalled.node_id} has had no progress for at least ${stalled.idle_ms}ms.`
  const attention = latestAttentionNode(state)
  if (attention) return `${attention.phase} node ${attention.id} is ${attention.status}.`
  return undefined
}

function inspectionHintsForState(
  state: WorkflowState,
  stalled: { node_id: string; session_id: string; idle_ms: number } | undefined,
): ControllerFeedback["inspection_hints"] {
  if (!stalled) return undefined
  return [{
    tool: "sp_status",
    args: { run_id: state.id, include_progress: true },
    reason: `Inspect stalled node ${stalled.node_id} before retrying or canceling.`,
  }]
}

function stalledRunningNode(_state: WorkflowState): { node_id: string; session_id: string; idle_ms: number } | undefined {
  void STALLED_PROGRESS_AFTER_MS
  return undefined
}
