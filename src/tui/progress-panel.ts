import type { NodeProgressEntry } from "../progress/node-progress"
import type { WorkflowState } from "../state/types"

export type ProgressPanelRow = {
  node_id: string
  task_id?: string
  agent: string
  phase: string
  durable_status: string
  activity_status: "active" | "stalled"
  session_id: string
  live_status: string
  latest_summary: string
  latest_detail?: string
  updated_at?: string
  observed_at?: string
  observed_age?: string
}

export type ProgressPanelViewModel = {
  active: boolean
  title: string
  summary: string
  workflow?: string
  status?: string
  current_phase?: string
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
  status: "pending" | "running" | "passed" | "failed" | "blocked" | "needs_user" | "interrupted"
  node_id?: string
}

export const STALLED_PROGRESS_AFTER_MS = 30_000

export function buildProgressPanelViewModel(
  state: WorkflowState | null,
  progressByNode: Record<string, NodeProgressEntry[]>,
  liveStatusBySession: Record<string, string>,
  now: Date = new Date(),
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

  return {
    active: true,
    title: "Superpowers Progress",
    summary: `${state.workflow} run ${state.id} is ${state.status} at ${state.current_phase}.`,
    workflow: state.workflow,
    status: state.status,
    current_phase: state.current_phase,
    pending_question: state.pending_question,
    rows: state.node_runs.map((node) => {
      const progress = progressByNode[node.id] ?? []
      const latest = progress.at(-1)
      const display = latestDisplayProgress(progress)
      const observedAt = latest?.at ?? node.reported_at ?? node.started_at
      return {
        node_id: node.id,
        task_id: node.task_id,
        agent: node.agent,
        phase: node.phase,
        durable_status: node.status,
        activity_status: node.status === "running" && isStalled(observedAt, now) ? "stalled" : "active",
        session_id: node.session_id,
        live_status: liveStatusBySession[node.session_id] ?? "unknown",
        latest_summary: display?.summary ?? "no progress recorded",
        latest_detail: display?.detail,
        updated_at: display?.at,
        observed_at: observedAt,
        observed_age: formatAge(observedAt, now),
      }
    }),
    tasks: progressTaskRows(state),
  }
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
      `SP: ${model.workflow} ${model.status}@${model.current_phase} | waiting user | ${model.pending_question.prompt} | ${latestActivityText(model)}`,
      max,
    )
  }
  const runningRows = model.rows.filter((row) => row.durable_status === "running")
  const running = runningRows.filter((row) => row.activity_status !== "stalled").length
  const stalled = runningRows.filter((row) => row.activity_status === "stalled").length
  const taskTotal = model.tasks.length
  const taskDone = model.tasks.filter((task) => task.status === "passed").length
  const taskSummary = taskTotal > 0 ? `tasks ${taskDone}/${taskTotal} done` : `nodes ${model.rows.length}`
  const sessionSummary = sessionStatusSummary(running, stalled)
  const activity = model.rows.length > 0 ? ` | ${latestActivityText(model)}` : ""
  return truncateLine(`SP: ${model.workflow} ${model.status}@${model.current_phase} | ${taskSummary} | sessions ${sessionSummary}${activity}`, max)
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
  const lines = [renderWorkflowStatusText(model, 160)]
  if (model.pending_question) {
    lines.push("waiting user")
    if (model.pending_question.source_node_id) lines.push(`source: ${model.pending_question.source_node_id}`)
    lines.push(`question: ${model.pending_question.prompt}`)
    if (model.pending_question.options?.length) {
      lines.push("options")
      lines.push(...model.pending_question.options.slice(0, 3).map((option) => `- ${option.label}${option.description ? `: ${option.description}` : ""}`))
    }
    const latest = latestActivityRow(model)
    if (latest) {
      lines.push("latest")
      lines.push(renderSidebarRow(latest))
    }
    return lines.join("\n")
  }
  const running = model.rows.filter((row) => row.durable_status === "running")
  if (running.length > 0) {
    lines.push("running")
    lines.push(...running.slice(0, maxRows).map(renderSidebarRow))
    if (running.length > maxRows) lines.push(`+${running.length - maxRows} more`)
    return lines.join("\n")
  }

  const latest = model.rows.at(-1)
  if (latest) {
    lines.push("latest")
    lines.push(renderSidebarRow(latest))
    return lines.join("\n")
  }

  lines.push("waiting for node dispatch")
  return lines.join("\n")
}

function renderSidebarRow(row: ProgressPanelRow): string {
  const task = row.task_id ? ` ${row.task_id}` : ""
  const age = row.observed_age ? ` (${row.observed_age})` : ""
  const detail = row.latest_detail ? `\n  ${truncateLine(row.latest_detail, 180)}` : ""
  return `${row.agent}${task}: ${displaySessionStatus(row)} - ${row.latest_summary}${age}${detail}`
}

function displaySessionStatus(row: ProgressPanelRow): string {
  if (row.durable_status === "running" && row.activity_status === "stalled") return "stalled"
  return row.durable_status
}

function sessionStatusSummary(running: number, stalled: number): string {
  const parts = []
  if (running > 0) parts.push(`${running} running`)
  if (stalled > 0) parts.push(`${stalled} stalled`)
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
      status: latestRun?.status ?? "pending",
      node_id: latestRun?.id,
    }
  })
}

function isStalled(observedAt: string | undefined, now: Date): boolean {
  if (!observedAt) return false
  const observed = Date.parse(observedAt)
  const current = now.getTime()
  if (!Number.isFinite(observed) || !Number.isFinite(current)) return false
  return current - observed >= STALLED_PROGRESS_AFTER_MS
}
