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
}

export type ProgressPanelTaskRow = {
  task_id: string
  title: string
  summary: string
  status: "pending" | "running" | "passed" | "failed" | "blocked" | "needs_user"
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
    rows: state.node_runs.map((node) => {
      const progress = progressByNode[node.id] ?? []
      const latest = progress.at(-1)
      const observedAt = latest?.at ?? node.started_at
      return {
        node_id: node.id,
        task_id: node.task_id,
        agent: node.agent,
        phase: node.phase,
        durable_status: node.status,
        activity_status: node.status === "running" && isStalled(observedAt, now) ? "stalled" : "active",
        session_id: node.session_id,
        live_status: liveStatusBySession[node.session_id] ?? "unknown",
        latest_summary: latest?.summary ?? "no progress recorded",
        latest_detail: latest?.detail,
        updated_at: latest?.at,
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
    lines.push(`  status: ${row.durable_status} / ${row.live_status} / ${row.activity_status}`)
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
  const live = row.live_status === "unknown" ? row.durable_status : `${row.durable_status}/${row.live_status}`
  const activity = row.activity_status === "stalled" ? "/stalled" : ""
  return truncateLine(`SP: ${row.agent}${task} ${live}${activity} - ${row.latest_summary}`, max)
}

export function renderWorkflowStatusText(model: ProgressPanelViewModel, max = 100): string {
  if (!model.active) return ""
  const running = model.rows.filter((row) => row.durable_status === "running").length
  const stalled = model.rows.filter((row) => row.durable_status === "running" && row.activity_status === "stalled").length
  const taskTotal = model.tasks.length
  const taskDone = model.tasks.filter((task) => task.status === "passed").length
  const taskSummary = taskTotal > 0 ? `tasks ${taskDone}/${taskTotal} done` : `nodes ${model.rows.length}`
  const stalledText = stalled > 0 ? `, ${stalled} stalled` : ""
  return truncateLine(`SP: ${model.workflow} ${model.status}@${model.current_phase} | ${taskSummary} | sessions ${running} running${stalledText}`, max)
}

export function renderRunningSessionsText(model: ProgressPanelViewModel, maxRows = 6): string {
  if (!model.active) return ""
  const running = model.rows.filter((row) => row.durable_status === "running")
  if (running.length === 0) return "SP running sessions\nnone"
  return [
    "SP running sessions",
    ...running.slice(0, maxRows).map((row) => {
      const task = row.task_id ? ` ${row.task_id}` : ""
      const activity = row.activity_status === "stalled" ? " stalled" : ""
      return `${row.agent}${task}: ${row.live_status}${activity} - ${row.latest_summary}`
    }),
    running.length > maxRows ? `+${running.length - maxRows} more` : "",
  ].filter(Boolean).join("\n")
}

export function renderUnfinishedTasksText(model: ProgressPanelViewModel, maxRows = 8): string {
  if (!model.active) return ""
  const unfinished = model.tasks.filter((task) => task.status !== "passed")
  if (unfinished.length === 0) return "SP unfinished tasks\nnone"
  return [
    "SP unfinished tasks",
    ...unfinished.slice(0, maxRows).map((task) => `${task.task_id}: ${task.status} - ${task.title}`),
    unfinished.length > maxRows ? `+${unfinished.length - maxRows} more` : "",
  ].filter(Boolean).join("\n")
}

function truncateLine(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
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
