import type { SessionAdapter } from "./adapter"
import type { WorkflowState } from "../state/types"

export const PARENT_PROGRESS_INTERVAL_MS = 10_000

type TimerHandle = unknown

export type ParentProgressTimer = {
  setInterval(callback: () => void | Promise<void>, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
}

export type ParentProgressNotifier = ReturnType<typeof createParentProgressNotifier>

export function createParentProgressNotifier(
  adapter: Pick<SessionAdapter, "continueNodeSession" | "showProgress">,
  options: {
    timer?: ParentProgressTimer
    intervalMs?: number
    now?: () => Date
  } = {},
) {
  void adapter
  void options

  return {
    start(args: {
      project: string
      runID: string
      readState: () => WorkflowState | null
    }): void {
      void args
    },
    stop(runID: string): void {
      void runID
    },
    activeCount(): number {
      return 0
    },
  }
}
