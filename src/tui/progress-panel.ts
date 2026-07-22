import type { NodeProgressEntry } from "../progress/node-progress"
import type { WorkflowState } from "../state/types"
import type { ChildLiveActivity } from "./live-activity"

export type ProgressPanelRow = {
  node_id: string
  task_id?: string
  agent: string
  phase: string
  durable_status: string
  activity_status: "active" | "stalled" | "waiting_permission"
  session_id: string
  live_status: string
  latest_summary: string
  latest_detail?: string
  updated_at?: string
  observed_at?: string
  observed_age?: string
  shortcut?: string
  focused?: boolean
  attention?: "running" | "waiting" | "blocked" | "failed" | "fallback" | "stalled" | "waiting_permission"
}

export type ProgressPanelViewModel = {
  active: boolean
  title: string
  summary: string
  workflow?: string
  status?: string
  current_phase?: string
  focused_session_id?: string
  selector_hint?: string
  session_counts?: {
    total: number
    running: number
    waiting: number
    blocked: number
    failed: number
    fallback_attention: number
  }
  rows: ProgressPanelRow[]
  tasks: ProgressPanelTaskRow[]
  pending_question?: {
    prompt: string
    source_node_id?: string
    options?: Array<{ label: string; description?: string }>
  }
}

export type ProgressPanelTaskRow = {
  task_id: string
  title: string
  summary: string
  agent?: string
  status:
    | "pending"
    | "running"
    | "passed"
    | "failed"
    | "blocked"
    | "needs_user"
    | "interrupted"
    | "dispatch_failed"
    | "notification_failed"
    | "canceled"
    | "skipped"
  node_id?: string
}

export const STALLED_PROGRESS_AFTER_MS = 30_000

export function buildProgressPanelViewModel(
  state: WorkflowState | null,
  progressByNode: Record<string, NodeProgressEntry[]>,
  liveStatusBySession: Record<string, string>,
  now: Date = new Date(),
  requestedFocusedSessionID?: string,
  liveActivityBySession: Record<string, ChildLiveActivity> = {},
): ProgressPanelViewModel {
  if (!state) {
    return {
      active: false,
      title: "Superpowers Progress",
      summary: "No active Superpowers workflow.",
      rows: [],
      tasks: [],
    }
  }

  const visibleNodes = visibleNodeRunsForDisplay(state.node_runs)
  const unsortedRows = visibleNodes.map((node) => {
    const progress = progressByNode[node.id] ?? []
    const latest = progress.at(-1)
    const display = latestDisplayProgress(progress)
    const liveActivity = liveActivityBySession[node.session_id]
    const merged = mergeRowActivity(display, liveActivity, node.status)
    const observedAt = merged.observed_at ?? latest?.at ?? node.reported_at ?? node.started_at
    const activityStatus = node.status === "running" && isWaitingPermission(liveStatusBySession[node.session_id])
      ? "waiting_permission"
      : node.status === "running" && isStalled(observedAt, now)
        ? "stalled"
        : "active"
    return {
      node_id: node.id,
      task_id: node.task_id,
      agent: node.agent,
      phase: node.phase,
      durable_status: node.status,
      activity_status: activityStatus,
      attention: rowAttention(node.status, activityStatus),
      session_id: node.session_id,
      live_status: liveStatusBySession[node.session_id] ?? "unknown",
      latest_summary: merged.summary,
      latest_detail: merged.detail,
      updated_at: display?.at,
      observed_at: observedAt,
      observed_age: formatAge(observedAt, now),
    } satisfies ProgressPanelRow
  })
  const sortedRows = sortSessionRows(unsortedRows)
  const focusedSessionID = selectFocusedSessionID(sortedRows, requestedFocusedSessionID)
  const rows = sortedRows.map((row, index) => ({
    ...row,
    shortcut: index < 9 ? `⌘${index + 1}` : undefined,
    focused: focusedSessionID ? row.session_id === focusedSessionID : false,
  }))

  return {
    active: true,
    title: "Superpowers Progress",
    summary: `${state.workflow} run ${state.id} is ${state.status} at ${state.current_phase}.`,
    workflow: state.workflow,
    status: state.status,
    current_phase: state.current_phase,
    focused_session_id: focusedSessionID,
    selector_hint: selectorHint(rows),
    session_counts: sessionCounts(rows),
    pending_question: state.pending_question,
    rows,
    tasks: progressTaskRows(state),
  }
}

/** Group key for sidebar display: one visible row per task+phase (or phase alone). */
export function nodeRunDisplayGroupKey(node: Pick<WorkflowState["node_runs"][number], "task_id" | "phase">): string {
  return node.task_id ? `${node.task_id}:${node.phase}` : node.phase
}

/**
 * Keep only the latest node run per display group so superseded interrupted/canceled
 * attempts do not clutter the sidebar. Durable `node_runs` history is unchanged.
 */
export function visibleNodeRunsForDisplay(
  nodeRuns: WorkflowState["node_runs"],
): WorkflowState["node_runs"] {
  const latestIndexByGroup = new Map<string, number>()
  nodeRuns.forEach((node, index) => {
    latestIndexByGroup.set(nodeRunDisplayGroupKey(node), index)
  })
  const keepIndexes = new Set(latestIndexByGroup.values())
  return nodeRuns.filter((_, index) => keepIndexes.has(index))
}

export function renderProgressPanelText(model: ProgressPanelViewModel): string {
  const lines = [model.title, "", model.summary]
  if (model.rows.length === 0) return lines.join("\n")

  lines.push("")
  for (const row of model.rows) {
    const task = row.task_id ? ` ${row.task_id}` : ""
    lines.push(`${row.node_id}${task}`)
    lines.push(`  ${row.agent} / ${row.phase}`)
    lines.push(`  status: ${displaySessionStatus(row)}`)
    if (row.live_status !== "unknown") lines.push(`  live: ${row.live_status}`)
    lines.push(`  session: ${row.session_id}`)
    lines.push(`  latest: ${row.latest_summary}`)
    if (row.latest_detail) lines.push(`  detail: ${row.latest_detail}`)
    if (row.updated_at) lines.push(`  updated: ${row.updated_at}`)
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

export function renderCompactProgressText(model: ProgressPanelViewModel, max = 120): string {
  if (!model.active) return ""
  const row = [...model.rows].reverse().find((candidate) => candidate.durable_status === "running") ?? model.rows.at(-1)
  if (!row) return "SP: active workflow has no child sessions"

  const task = row.task_id ? ` ${row.task_id}` : ""
  return truncateLine(`SP: ${row.agent}${task} ${displaySessionStatus(row)} - ${row.latest_summary}`, max)
}

export function renderWorkflowStatusText(model: ProgressPanelViewModel, max = 180): string {
  if (!model.active) return ""
  if (model.pending_question) {
    return truncateLine(
      `SP: ${model.workflow} ${model.status}@${model.current_phase} | ${childSessionSummary(model)} | waiting user | ${model.pending_question.prompt} | ${latestActivityText(model)}`,
      max,
    )
  }
  const taskTotal = model.tasks.length
  const taskDone = model.tasks.filter((task) => task.status === "passed").length
  const taskSummary = taskTotal > 0 ? `tasks ${taskDone}/${taskTotal} done` : `nodes ${model.rows.length}`
  const activity = model.rows.length > 0 ? ` | ${latestActivityText(model)}` : ""
  return truncateLine(`SP: ${model.workflow} ${model.status}@${model.current_phase} | ${taskSummary} | ${childSessionSummary(model)}${activity}`, max)
}

export function renderAppBottomChildPanelText(model: ProgressPanelViewModel, maxRows = 5): string {
  if (!model.active) return ""
  const lines = [renderWorkflowStatusText(model, 160)]
  if (model.session_counts) lines.push(sessionCountsText(model.session_counts))
  if (model.pending_question) {
    lines.push("waiting user")
    lines.push(`question: ${model.pending_question.prompt}`)
    const latest = latestActivityRow(model)
    if (latest) lines.push(renderAppBottomRow(latest))
    if (model.selector_hint) lines.push(`nav: ${model.selector_hint}`)
    return lines.join("\n")
  }
  if (model.rows.length > 0) {
    lines.push("child sessions")
    lines.push(...model.rows.slice(0, maxRows).map(renderAppBottomRow))
    if (model.rows.length > maxRows) lines.push(`+${model.rows.length - maxRows} more`)
  } else {
    lines.push(emptyNodeDispatchHint(model))
  }
  const planned = plannedTaskRows(model)
  if (planned.length > 0) {
    const visiblePlanned = Math.max(0, maxRows - Math.min(model.rows.length, maxRows))
    if (visiblePlanned > 0) {
      lines.push("planned")
      lines.push(...planned.slice(0, visiblePlanned).map(renderPlannedTaskRow))
      if (planned.length > visiblePlanned) lines.push(`+${planned.length - visiblePlanned} more planned`)
    }
  }
  if (model.selector_hint && model.rows.length > 0) lines.push(`nav: ${model.selector_hint}`)
  return lines.join("\n")
}

function renderAppBottomRow(row: ProgressPanelRow): string {
  const task = row.task_id ? ` ${row.task_id}` : ""
  const age = row.observed_age ? ` (${row.observed_age})` : ""
  const marker = row.focused ? ">" : " "
  const shortcut = row.shortcut ? `[${row.shortcut}] ` : ""
  const attention = row.attention ? ` | ${row.attention}` : ""
  return `${marker} ${shortcut}${row.agent}${task}: ${displaySessionStatus(row)} - ${truncateLine(row.latest_summary, 96)}${age}${attention}`
}

export function renderRunningSessionsText(model: ProgressPanelViewModel, maxRows = 6): string {
  if (!model.active) return ""
  const running = model.rows.filter((row) => row.durable_status === "running")
  if (running.length === 0) return "SP running sessions\nnone"
  return [
    "SP running sessions",
    ...running.slice(0, maxRows).map((row) => {
      const task = row.task_id ? ` ${row.task_id}` : ""
      return `${row.agent}${task}: ${displaySessionStatus(row)} - ${row.latest_summary}`
    }),
    running.length > maxRows ? `+${running.length - maxRows} more` : "",
  ].filter(Boolean).join("\n")
}

export function renderSidebarProgressText(model: ProgressPanelViewModel, maxRows = 6): string {
  if (!model.active) return ""
  const lines = [renderSidebarWorkflowHeader(model)]
  if (model.pending_question) {
    lines.push("waiting user")
    lines.push(`question: ${truncateLine(model.pending_question.prompt, 96)}`)
    if (model.pending_question.options?.length) {
      lines.push(...model.pending_question.options.slice(0, 3).map((option) => `- ${option.label}`))
    }
    const latest = latestActivityRow(model)
    if (latest) lines.push(...renderCompactSidebarRow(latest))
    return lines.join("\n")
  }
  if (model.rows.length > 0) {
    for (const row of model.rows.slice(0, maxRows)) {
      lines.push(...renderCompactSidebarRow(row))
    }
    if (model.rows.length > maxRows) lines.push(`+${model.rows.length - maxRows} more`)
    const planned = plannedTaskRows(model)
    if (planned.length > 0) {
      lines.push("planned")
      lines.push(...planned.slice(0, maxRows).map(renderPlannedTaskRow))
      if (planned.length > maxRows) lines.push(`+${planned.length - maxRows} more planned`)
    }
    return lines.join("\n")
  }

  const planned = plannedTaskRows(model)
  if (planned.length > 0) {
    lines.push("planned")
    lines.push(...planned.slice(0, maxRows).map(renderPlannedTaskRow))
    if (planned.length > maxRows) lines.push(`+${planned.length - maxRows} more planned`)
    return lines.join("\n")
  }

  lines.push(emptyNodeDispatchHint(model))
  return lines.join("\n")
}

/** Terminal workflows with no child nodes should not pin the sidebar progress block. */
export function shouldShowSidebarWorkflowProgress(state: WorkflowState | null | undefined): boolean {
  if (!state) return false
  if ((state.status === "passed" || state.status === "canceled") && state.node_runs.length === 0) {
    return false
  }
  return true
}

function emptyNodeDispatchHint(model: ProgressPanelViewModel): string {
  if (model.status === "canceled") return "workflow canceled · no child sessions"
  if (model.status === "passed") return "workflow finished · no child sessions"
  return "waiting for node dispatch"
}

function renderSidebarWorkflowHeader(model: ProgressPanelViewModel): string {
  const workflow = model.workflow || "workflow"
  const phase = model.current_phase || model.status || "active"
  if (model.status && model.status !== "running" && model.status !== phase) {
    return truncateLine(`SP ${workflow} · ${phase} (${model.status})`, 72)
  }
  return truncateLine(`SP ${workflow} · ${phase}`, 72)
}

function renderCompactSidebarRow(row: ProgressPanelRow): string[] {
  const task = row.task_id ? ` ${row.task_id}` : ""
  const marker = row.focused ? "●" : " "
  const shortcut = row.shortcut ? `[${row.shortcut}] ` : ""
  const status = displaySessionStatus(row)
  const age = row.observed_age ? ` (${row.observed_age})` : ""
  const lines = [`${marker} ${shortcut}${row.agent}${task}  ${status}`]
  const activity = compactSidebarActivity(row.latest_summary, age)
  if (activity) lines.push(`  ${activity}`)
  return lines
}

function compactSidebarActivity(summary: string | undefined, age: string): string | undefined {
  const trimmed = summary?.trim()
  if (!trimmed) return undefined
  if (isNoisySidebarDetail(trimmed)) return undefined
  return truncateLine(`${trimmed}${age}`, 72)
}

function isNoisySidebarDetail(value: string): boolean {
  if (value.includes("sidebar-debug.log")) return true
  if (/^\/Users\/|^\/home\/|^[A-Za-z]:\\/.test(value)) return true
  if (/^msg_[A-Za-z0-9]+$/.test(value)) return true
  return false
}

function renderPlannedTaskRow(task: ProgressPanelTaskRow): string {
  const agent = task.agent ? `${task.agent} ` : ""
  return `${agent}${task.task_id}: ${task.status} - ${task.title}`
}

function displaySessionStatus(row: ProgressPanelRow): string {
  if (row.durable_status === "running" && row.activity_status === "waiting_permission") return "waiting permission"
  if (row.durable_status === "running" && row.activity_status === "stalled") return "stalled"
  return row.durable_status
}

function childSessionSummary(model: ProgressPanelViewModel): string {
  const rows = model.rows
  const runningRows = rows.filter((row) => row.durable_status === "running")
  const running = runningRows.filter((row) => row.activity_status === "active").length
  const stalled = runningRows.filter((row) => row.activity_status === "stalled").length
  const waitingPermission = runningRows.filter((row) => row.activity_status === "waiting_permission").length
  const active = running + stalled + waitingPermission
  return `children ${active} active (${sessionStatusSummary(running, stalled, waitingPermission)})`
}

function sessionStatusSummary(running: number, stalled: number, waitingPermission = 0): string {
  const parts = []
  if (running > 0) parts.push(`${running} running`)
  if (stalled > 0) parts.push(`${stalled} stalled`)
  if (waitingPermission > 0) parts.push(`${waitingPermission} waiting permission`)
  return parts.length > 0 ? parts.join(", ") : "0 running"
}

function truncateLine(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

function latestActivityRow(model: ProgressPanelViewModel): ProgressPanelRow | undefined {
  return [...model.rows].sort((left, right) => timestamp(right.observed_at) - timestamp(left.observed_at)).at(0)
}

function latestActivityText(model: ProgressPanelViewModel): string {
  const row = latestActivityRow(model)
  if (!row) return "no child session"
  const task = row.task_id ? ` ${row.task_id}` : ""
  const age = row.observed_age ? ` (${row.observed_age})` : ""
  return `${row.agent}${task} ${displaySessionStatus(row)} - ${row.latest_summary}${age}`
}

function latestDisplayProgress(progress: NodeProgressEntry[]): NodeProgressEntry | undefined {
  const latest = progress.at(-1)
  return [...progress].reverse().find((entry) => isDisplayProgress(entry)) ?? latest
}

function isDisplayProgress(entry: NodeProgressEntry): boolean {
  return entry.kind !== "session_status" && entry.kind !== "session_idle"
}

function isWaitingPermission(status: string | undefined): boolean {
  return status === "waiting_permission" || status === "waiting permission"
}

function sortSessionRows(rows: ProgressPanelRow[]): ProgressPanelRow[] {
  return [...rows].sort((left, right) => {
    const attention = rowPriority(left) - rowPriority(right)
    if (attention !== 0) return attention
    const updated = timestamp(right.observed_at) - timestamp(left.observed_at)
    if (updated !== 0) return updated
    return left.node_id.localeCompare(right.node_id)
  })
}

function rowPriority(row: ProgressPanelRow): number {
  if (row.durable_status === "running" && row.activity_status === "active") return 0
  if (row.durable_status === "running" && row.activity_status === "waiting_permission") return 1
  if (row.durable_status === "needs_user") return 2
  if (row.durable_status === "blocked") return 3
  if (row.durable_status === "dispatch_failed" || row.durable_status === "notification_failed") return 4
  if (row.durable_status === "failed") return 5
  if (row.durable_status === "running" && row.activity_status === "stalled") return 6
  return 10
}

function rowAttention(
  status: ProgressPanelRow["durable_status"],
  activityStatus: ProgressPanelRow["activity_status"],
): ProgressPanelRow["attention"] | undefined {
  if (status === "running" && activityStatus === "waiting_permission") return "waiting_permission"
  if (status === "running" && activityStatus === "stalled") return "stalled"
  if (status === "running") return "running"
  if (status === "needs_user") return "waiting"
  if (status === "blocked") return "blocked"
  if (status === "failed") return "failed"
  if (status === "dispatch_failed" || status === "notification_failed") return "fallback"
  return undefined
}

function selectFocusedSessionID(rows: ProgressPanelRow[], requested?: string): string | undefined {
  if (requested && rows.some((row) => row.session_id === requested)) return requested
  return rows.find((row) => row.durable_status === "running" && row.activity_status === "active")?.session_id
    ?? rows.find((row) => row.durable_status === "running")?.session_id
    ?? rows.find((row) => row.durable_status === "needs_user")?.session_id
    ?? rows.at(0)?.session_id
}

function selectorHint(rows: ProgressPanelRow[]): string | undefined {
  if (rows.length === 0) return undefined
  const visibleCount = Math.min(rows.length, 9)
  return `⌘1..⌘${visibleCount}, ⌘[/⌘]`
}

function sessionCounts(rows: ProgressPanelRow[]): ProgressPanelViewModel["session_counts"] {
  return {
    total: rows.length,
    running: rows.filter((row) => row.durable_status === "running").length,
    waiting: rows.filter((row) => row.durable_status === "needs_user" || row.activity_status === "waiting_permission").length,
    blocked: rows.filter((row) => row.durable_status === "blocked").length,
    failed: rows.filter((row) => row.durable_status === "failed").length,
    fallback_attention: rows.filter((row) => row.durable_status === "dispatch_failed" || row.durable_status === "notification_failed").length,
  }
}

function sessionCountsText(counts: NonNullable<ProgressPanelViewModel["session_counts"]>): string {
  const attention = counts.waiting + counts.blocked + counts.failed + counts.fallback_attention
  const parts = []
  if (counts.waiting > 0) parts.push(`waiting ${counts.waiting}`)
  if (counts.blocked > 0) parts.push(`blocked ${counts.blocked}`)
  if (counts.failed > 0) parts.push(`failed ${counts.failed}`)
  if (counts.fallback_attention > 0) parts.push(`fallback ${counts.fallback_attention}`)
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : ""
  return `sessions total ${counts.total} | running ${counts.running} | attention ${attention}${detail}`
}

function formatAge(value: string | undefined, now: Date): string | undefined {
  if (!value) return undefined
  const at = Date.parse(value)
  const current = now.getTime()
  if (!Number.isFinite(at) || !Number.isFinite(current)) return undefined
  const diff = Math.max(0, current - at)
  if (diff < 1000) return "now"
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function progressTaskRows(state: WorkflowState): ProgressPanelTaskRow[] {
  const tasks = state.task_graph?.tasks ?? []
  if (tasks.length === 0) {
    return state.node_runs
      .filter((node) => node.task_id)
      .map((node) => ({
        task_id: node.task_id as string,
        title: node.task_id as string,
        summary: node.phase,
        agent: node.agent,
        status: node.status,
        node_id: node.id,
      }))
  }
  return tasks.map((task) => {
    const latestRun = [...state.node_runs].reverse().find((node) => node.task_id === task.id)
    return {
      task_id: task.id,
      title: task.title,
      summary: task.summary,
      agent: latestRun?.agent ?? task.agent,
      status: latestRun?.status ?? "pending",
      node_id: latestRun?.id,
    }
  })
}

function plannedTaskRows(model: ProgressPanelViewModel): ProgressPanelTaskRow[] {
  return model.tasks.filter((task) => !task.node_id && [
    "pending",
    "blocked",
    "needs_user",
    "dispatch_failed",
    "notification_failed",
    "interrupted",
  ].includes(task.status))
}

function mergeRowActivity(
  progress: NodeProgressEntry | undefined,
  liveActivity: ChildLiveActivity | undefined,
  durableStatus: ProgressPanelRow["durable_status"],
): { summary: string; detail?: string; observed_at?: string } {
  if (durableStatus === "running" && liveActivity?.summary) {
    return {
      summary: liveActivity.summary,
      detail: liveActivity.detail ?? progress?.detail,
      observed_at: liveActivity.observed_at,
    }
  }
  if (progress) {
    return {
      summary: progress.summary,
      detail: progress.detail,
      observed_at: progress.at,
    }
  }
  if (liveActivity?.summary) {
    return {
      summary: liveActivity.summary,
      detail: liveActivity.detail,
      observed_at: liveActivity.observed_at,
    }
  }
  return { summary: "no progress recorded" }
}

function isStalled(observedAt: string | undefined, now: Date): boolean {
  if (!observedAt) return false
  const observed = Date.parse(observedAt)
  const current = now.getTime()
  if (!Number.isFinite(observed) || !Number.isFinite(current)) return false
  return current - observed >= STALLED_PROGRESS_AFTER_MS
}
