import { createNodeProgressStore } from "../progress/node-progress"
import type { SessionAdapter } from "./adapter"
import type { WorkflowState } from "../state/types"
import {
  buildProgressPanelViewModel,
  renderSidebarProgressText,
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
    const prompt = buildParentProgressPrompt(state, entry.project, now())
    entry.inFlight = true
    try {
      await adapter.continueNodeSession({
        sessionID: state.parent_session_id,
        agent: "super-agent",
        prompt,
      })
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
  const progress = createNodeProgressStore(project).readRun(state)
  const model = buildProgressPanelViewModel(state, progress, {}, now)
  return [
    "Superpowers progress update",
    "",
    "请直接向用户输出下面这条工作流进度。不要调用工具，不要推进工作流，不要要求用户确认。",
    "",
    renderSidebarProgressText(model),
  ].join("\n").trim()
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
