import { createNodeProgressStore } from "../progress/node-progress"
import type { SessionAdapter } from "./adapter"
import type { WorkflowState } from "../state/types"
import {
  buildProgressPanelViewModel,
  renderSidebarProgressText,
  type ProgressPanelViewModel,
} from "../tui/progress-panel"

export const PARENT_PROGRESS_INTERVAL_MS = 10_000

type TimerHandle = unknown

export type ParentProgressTimer = {
  setInterval(callback: () => void | Promise<void>, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
}

export type ParentProgressNotifier = ReturnType<typeof createParentProgressNotifier>

type ParentProgressEntry = {
  handle: TimerHandle
  inFlight: boolean
  lastProgressKey?: string
  readState: () => WorkflowState | null
  project: string
}

export function createParentProgressNotifier(
  adapter: Pick<SessionAdapter, "continueNodeSession" | "showProgress">,
  options: {
    timer?: ParentProgressTimer
    intervalMs?: number
    now?: () => Date
  } = {},
) {
  const timer = options.timer ?? defaultTimer
  const intervalMs = options.intervalMs ?? PARENT_PROGRESS_INTERVAL_MS
  const now = options.now ?? (() => new Date())
  const active = new Map<string, ParentProgressEntry>()

  function stop(runID: string): void {
    const entry = active.get(runID)
    if (!entry) return
    timer.clearInterval(entry.handle)
    active.delete(runID)
  }

  async function tick(runID: string): Promise<void> {
    const entry = active.get(runID)
    if (!entry || entry.inFlight) return
    const state = entry.readState()
    if (!isParentProgressActive(state, runID)) {
      stop(runID)
      return
    }
    const model = buildParentProgressModel(state, entry.project, now())
    const progressKey = stableProgressKey(model)
    if (entry.lastProgressKey === progressKey) return
    const message = renderSidebarProgressText(model)
    entry.inFlight = true
    try {
      await adapter.showProgress({
        stage: "parent_progress",
        title: "Superpowers workflow",
        message,
        variant: "info",
      })
      entry.lastProgressKey = progressKey
    } catch (error) {
      await adapter.showProgress({
        stage: "parent_progress_failed",
        title: "Superpowers workflow",
        message: `Failed to notify parent session about workflow progress. ${errorMessage(error)}`,
        variant: "warning",
      })
    } finally {
      const latest = active.get(runID)
      if (latest) latest.inFlight = false
    }
  }

  return {
    start(args: {
      project: string
      runID: string
      readState: () => WorkflowState | null
    }): void {
      if (process.env.OPENCODE_SUPERPOWERS_DISABLE_CHILD_PROMPT === "1") return
      const state = args.readState()
      if (!isParentProgressActive(state, args.runID)) return
      if (active.has(args.runID)) {
        const existing = active.get(args.runID)
        if (existing) {
          existing.project = args.project
          existing.readState = args.readState
        }
        return
      }
      const handle = timer.setInterval(() => {
        void tick(args.runID)
      }, intervalMs)
      active.set(args.runID, {
        handle,
        inFlight: false,
        lastProgressKey: undefined,
        readState: args.readState,
        project: args.project,
      })
    },
    stop,
    activeCount(): number {
      return active.size
    },
  }
}

export function buildParentProgressPrompt(state: WorkflowState, project: string, now = new Date()): string {
  const model = buildParentProgressModel(state, project, now)
  return [
    "Superpowers progress update",
    "",
    "请直接向用户输出下面这条工作流进度。不要调用工具，不要推进工作流，不要要求用户确认。",
    "",
    renderSidebarProgressText(model),
  ].join("\n").trim()
}

function buildParentProgressModel(state: WorkflowState, project: string, now: Date): ProgressPanelViewModel {
  const progress = createNodeProgressStore(project).readRun(state)
  return buildProgressPanelViewModel(state, progress, {}, now)
}

function stableProgressKey(model: ProgressPanelViewModel): string {
  return JSON.stringify({
    workflow: model.workflow,
    status: model.status,
    current_phase: model.current_phase,
    pending_question: model.pending_question,
    rows: model.rows.map((row) => ({
      node_id: row.node_id,
      task_id: row.task_id,
      agent: row.agent,
      phase: row.phase,
      durable_status: row.durable_status,
      activity_status: row.activity_status,
      live_status: row.live_status,
      latest_summary: row.latest_summary,
      latest_detail: row.latest_detail,
      updated_at: row.updated_at,
    })),
    tasks: model.tasks.map((task) => ({
      task_id: task.task_id,
      status: task.status,
      node_id: task.node_id,
    })),
  })
}

function isParentProgressActive(state: WorkflowState | null, runID: string): state is WorkflowState {
  return Boolean(
      state &&
      state.id === runID &&
      state.status === "running" &&
      state.node_runs.some((node) => node.status === "running" && !isForegroundSerialPhase(node.phase)),
  )
}

function isForegroundSerialPhase(phase: string): boolean {
  return phase === "design" || phase === "plan"
}

const defaultTimer: ParentProgressTimer = {
  setInterval(callback, ms) {
    return setInterval(callback, ms)
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Unknown error."
}
