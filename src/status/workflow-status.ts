import { createNodeProgressStore, type NodeProgressEntry } from "../progress/node-progress"
import { buildAllowedControllerDecisions } from "../controller/feedback"
import type { WorkflowState } from "../state/types"
import { buildProgressPanelViewModel, STALLED_PROGRESS_AFTER_MS } from "../tui/progress-panel"

export type WorkflowStatusDetail = "summary" | "task" | "sessions" | "full"

export type WorkflowStatusSnapshot = ReturnType<typeof buildWorkflowStatusSnapshot>

export function buildWorkflowStatusSnapshot(args: {
  state: WorkflowState
  detail?: WorkflowStatusDetail
  taskID?: string
  sessionID?: string
  includeProgress?: boolean
  progressTail?: number
  now?: Date
}) {
  const detail = args.detail ?? (args.taskID ? "task" : "summary")
  const progressByNode = createNodeProgressStore(args.state.project).readRun(args.state)
  const now = args.now ?? new Date()
  const model = buildProgressPanelViewModel(args.state, progressByNode, {}, now)
  const allSessions = model.rows.map((row) => {
    const progress = progressByNode[row.node_id] ?? []
    const tail = progress.slice(-safeProgressTail(args.progressTail))
    return {
      node_id: row.node_id,
      task_id: row.task_id,
      agent: row.agent,
      phase: row.phase,
      session_id: row.session_id,
      durable_status: row.durable_status,
      activity_status: row.activity_status,
      latest_progress: latestProgressSummary(progress, now),
      progress_tail: args.includeProgress ? tail : undefined,
      live: {
        status: "unknown",
        source: "unavailable_in_tool_context",
      },
    }
  })
  const sessions = args.sessionID ? allSessions.filter((session) => session.session_id === args.sessionID) : allSessions
  const task = args.taskID ? focusTask(args.state, args.taskID, progressByNode, args.includeProgress, args.progressTail, now) : undefined

  return {
    source: "runtime_memory",
    runtime: {
      source: "runtime_memory",
      loaded_from: "durable_snapshot_after_startup_reconciliation",
      status_authority: "runtime_memory",
    },
    durable: {
      role: "snapshot",
      project: args.state.project,
      run_id: args.state.id,
      note: "Durable files are recovery and audit material; runtime memory is the current status authority.",
    },
    summary: {
      id: args.state.id,
      workflow: args.state.workflow,
      status: args.state.status,
      phase: args.state.current_phase,
      activation: args.state.activation,
      updated_at: args.state.updated_at,
      parent_session_id: args.state.parent_session_id,
      tasks: model.tasks.length > 0
        ? {
            total: model.tasks.length,
            passed: model.tasks.filter((candidate) => candidate.status === "passed").length,
            running: model.tasks.filter((candidate) => candidate.status === "running").length,
            blocked: model.tasks.filter((candidate) => ["failed", "blocked", "needs_user", "interrupted"].includes(candidate.status)).length,
          }
        : undefined,
      sessions: {
        total: allSessions.length,
        running: allSessions.filter((session) => session.durable_status === "running").length,
        stalled: allSessions.filter((session) => session.activity_status === "stalled").length,
        interrupted: allSessions.filter((session) => session.durable_status === "interrupted").length,
      },
    },
    node_summary: buildNodeSummary(args.state, allSessions),
    current: args.state,
    task,
    sessions: detail === "sessions" || detail === "full" || args.sessionID ? sessions : undefined,
    recommended_next: recommendedNext(args.state, allSessions),
    allowed_controller_decisions: buildAllowedControllerDecisions(args.state),
    progress_digest: args.includeProgress ? buildProgressDigest(args.state, progressByNode, allSessions, now, args.progressTail) : undefined,
  }
}

function buildNodeSummary(
  state: WorkflowState,
  sessions: Array<{
    node_id: string
    task_id?: string
    agent: string
    phase: string
    session_id: string
    durable_status: string
    activity_status: string
    latest_progress: ReturnType<typeof latestProgressSummary>
  }>,
) {
  const unfinishedStatuses = new Set(["running", "interrupted", "blocked", "failed", "needs_user", "dispatch_failed", "notification_failed"])
  const nodes = sessions.map((session) => nodeSummaryEntry(session))
  const unfinished = nodes.filter((node) => unfinishedStatuses.has(node.status))
  const latestByTask = latestNodeByTask(nodes)
  return {
    total: nodes.length,
    counts: countNodesByStatus(nodes),
    last_node: nodes.at(-1),
    unfinished_nodes: unfinished,
    running_nodes: nodes.filter((node) => node.status === "running"),
    blocked_nodes: nodes.filter((node) => ["blocked", "failed", "needs_user", "dispatch_failed", "notification_failed"].includes(node.status)),
    interrupted_nodes: nodes.filter((node) => node.status === "interrupted"),
    latest_by_task: latestByTask,
    task_completion: state.task_graph?.tasks.length
      ? {
          total: state.task_graph.tasks.length,
          passed: latestByTask.filter((node) => node.status === "passed").length,
          unfinished: latestByTask.filter((node) => unfinishedStatuses.has(node.status)).length,
          pending: state.task_graph.tasks.length - latestByTask.length,
        }
      : undefined,
    detail_hint: "For complete per-session progress tails, call sp_status with detail=\"sessions\" or detail=\"full\" and include_progress=true.",
  }
}

function nodeSummaryEntry(session: {
  node_id: string
  task_id?: string
  agent: string
  phase: string
  session_id: string
  durable_status: string
  activity_status: string
  latest_progress: ReturnType<typeof latestProgressSummary>
}) {
  return {
    node_id: session.node_id,
    task_id: session.task_id,
    agent: session.agent,
    phase: session.phase,
    session_id: session.session_id,
    status: session.durable_status,
    activity_status: session.activity_status,
    latest_progress: session.latest_progress.present
      ? {
          at: session.latest_progress.at,
          kind: session.latest_progress.kind,
          summary: session.latest_progress.summary,
        }
      : undefined,
  }
}

function countNodesByStatus(nodes: Array<{ status: string }>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const node of nodes) counts[node.status] = (counts[node.status] ?? 0) + 1
  return counts
}

function latestNodeByTask<T extends { task_id?: string }>(nodes: T[]): T[] {
  const latest = new Map<string, T>()
  for (const node of nodes) {
    if (!node.task_id) continue
    latest.set(node.task_id, node)
  }
  return [...latest.values()]
}

function buildProgressDigest(
  state: WorkflowState,
  progressByNode: Record<string, NodeProgressEntry[]>,
  sessions: Array<{
    node_id: string
    task_id?: string
    agent: string
    phase: string
    session_id: string
    durable_status: string
    activity_status: string
    latest_progress: ReturnType<typeof latestProgressSummary>
  }>,
  now: Date,
  progressTail: number | undefined,
) {
  const recommended = recommendedNext(state, sessions)
  const recent = recentProgressEntries(progressByNode, safeProgressTail(progressTail))
  const latest = recent.at(-1)
  return {
    delivery: "on_demand_tool_result",
    display_policy: "main_session_summary",
    note: "Progress digest is for on demand main-session tool results; realtime progress belongs in TUI surfaces.",
    run_id: state.id,
    workflow: state.workflow,
    status: state.status,
    phase: state.current_phase,
    updated_at: state.updated_at,
    recommended_next: recommended.action,
    attention: attentionSummary(state, recommended),
    current_activity: latest ? progressDigestEntry(latest, now) : undefined,
    recent_activity: recent.map((entry) => progressDigestEntry(entry, now)),
  }
}

function recentProgressEntries(progressByNode: Record<string, NodeProgressEntry[]>, limit: number): NodeProgressEntry[] {
  return Object.values(progressByNode)
    .flat()
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .slice(-limit)
}

function progressDigestEntry(entry: NodeProgressEntry, now: Date) {
  const ageMs = now.getTime() - Date.parse(entry.at)
  return {
    at: entry.at,
    age_ms: Number.isFinite(ageMs) ? Math.max(0, ageMs) : undefined,
    node_id: entry.node_id,
    session_id: entry.session_id,
    agent: entry.agent,
    phase: entry.phase,
    task_id: entry.task_id,
    kind: entry.kind,
    summary: entry.summary,
    detail: entry.detail,
  }
}

function attentionSummary(state: WorkflowState, recommended: ReturnType<typeof recommendedNext>) {
  if (state.status === "waiting_user" && state.pending_question) {
    return {
      kind: "question",
      summary: state.pending_question.prompt,
      next_action: recommended.action,
    }
  }
  if (state.status === "awaiting_design_approval" || state.status === "awaiting_plan_approval") {
    return {
      kind: "approval",
      summary: recommended.reason,
      next_action: recommended.action,
    }
  }
  if (["blocked", "failed", "waiting_user_decision", "waiting_controller_decision", "recovered_unknown"].includes(state.status)) {
    return {
      kind: state.status === "failed" ? "failed" : "blocked",
      summary: recommended.reason,
      next_action: recommended.action,
    }
  }
  if (recommended.action === "inspect_or_cancel_stalled_node") {
    return {
      kind: "stalled",
      summary: recommended.reason,
      next_action: recommended.action,
    }
  }
  return {
    kind: "none",
    summary: recommended.reason,
    next_action: recommended.action,
  }
}

function focusTask(
  state: WorkflowState,
  taskID: string,
  progressByNode: Record<string, NodeProgressEntry[]>,
  includeProgress: boolean | undefined,
  progressTail: number | undefined,
  now: Date,
) {
  const task = state.task_graph?.tasks.find((candidate) => candidate.id === taskID)
  const nodeRuns = state.node_runs.filter((run) => run.task_id === taskID)
  return {
    task,
    node_runs: nodeRuns,
    attempts: nodeRuns.map((node) => ({
      node_id: node.id,
      phase: node.phase,
      agent: node.agent,
      session_id: node.session_id,
      durable_status: node.status,
      started_at: node.started_at,
      ended_at: node.ended_at,
      reported_at: node.reported_at,
      latest_progress: latestProgressSummary(progressByNode[node.id] ?? [], now),
      progress_tail: includeProgress ? (progressByNode[node.id] ?? []).slice(-safeProgressTail(progressTail)) : undefined,
    })),
    latest_report: [...nodeRuns].reverse().find((run) => run.record_path),
  }
}

function latestProgressSummary(progress: NodeProgressEntry[], now: Date) {
  const latest = progress.at(-1)
  if (!latest) {
    return {
      present: false,
      summary: "no progress recorded",
    }
  }
  const ageMs = now.getTime() - Date.parse(latest.at)
  return {
    present: true,
    at: latest.at,
    age_ms: Number.isFinite(ageMs) ? Math.max(0, ageMs) : undefined,
    kind: latest.kind,
    summary: latest.summary,
    detail: latest.detail,
  }
}

function recommendedNext(
  state: WorkflowState,
  sessions: Array<{ durable_status: string; activity_status: string; task_id?: string; node_id: string }>,
) {
  if (state.status === "waiting_user" && state.pending_question) {
    return {
      action: "answer_pending_question",
      reason: "Workflow is waiting for user input.",
      source_node_id: state.pending_question.source_node_id,
    }
  }
  if (state.status === "awaiting_design_approval") {
    return {
      action: "approve_or_revise_design",
      reason: "Candidate design is waiting for approval or revision.",
    }
  }
  if (state.status === "awaiting_plan_approval") {
    return {
      action: "approve_or_revise_plan",
      reason: "Candidate plan is waiting for approval or revision.",
    }
  }
  if (state.status === "recovered_unknown") {
    return {
      action: "resume_or_cancel_recovered_workflow",
      reason: "Startup recovery found previously running nodes. Call sp_start(run_id, resume=\"all\") or resume=[task_id] to continue interrupted tasks; use sp_cancel to stop.",
    }
  }
  const dispatchFailed = [...state.node_runs].reverse().find((node) => node.status === "dispatch_failed")
  if (dispatchFailed) {
    return {
      action: "retry_dispatch_or_cancel",
      reason: "A child dispatch failed before the node could run.",
      task_id: dispatchFailed.task_id,
      node_id: dispatchFailed.id,
    }
  }
  const interrupted = blockingInterruptedNode(state)
  if (interrupted) {
    return {
      action: "retry_or_cancel_interrupted_task",
      reason: "Startup recovery marked a previously running node as interrupted.",
      task_id: interrupted?.task_id,
      node_id: interrupted?.id,
    }
  }
  if (state.status === "waiting_controller_decision") {
    return {
      action: "resolve_controller_decision",
      reason: "Workflow is waiting for the controller to apply or reject a runtime decision.",
    }
  }
  const stalled = sessions.find((session) => session.durable_status === "running" && session.activity_status === "stalled")
  if (stalled) {
    return {
      action: "inspect_or_cancel_stalled_node",
      reason: `No progress event has been observed for at least ${STALLED_PROGRESS_AFTER_MS}ms.`,
      task_id: stalled.task_id,
      node_id: stalled.node_id,
    }
  }
  const running = sessions.find((session) => session.durable_status === "running")
  if (running) {
    return {
      action: "wait_running_node",
      reason: "Runtime memory has a running node.",
      task_id: running.task_id,
      node_id: running.node_id,
    }
  }
  if (state.status === "blocked" || state.status === "failed") {
    return {
      action: "inspect_blocked_workflow",
      reason: `Workflow is ${state.status}.`,
    }
  }
  return {
    action: "none",
    reason: `Workflow is ${state.status}.`,
  }
}

function blockingInterruptedNode(state: WorkflowState) {
  return [...state.node_runs].reverse().find((node) => {
    if (node.status !== "interrupted") return false
    if (!node.task_id) return true
    const latestForTask = [...state.node_runs].reverse().find((candidate) => candidate.task_id === node.task_id)
    return latestForTask?.id === node.id
  })
}

function safeProgressTail(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 3
  return Math.max(1, Math.min(50, Math.trunc(value)))
}
