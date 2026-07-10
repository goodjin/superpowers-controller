import type { NodeProgressEntry } from "../progress/node-progress"
import { STALLED_PROGRESS_AFTER_MS } from "../tui/progress-panel"
import type { WorkflowState } from "../state/types"

export type PermissionWaitingContext = {
  session_id: string
  node_id: string
  hint: string
}

export type StalledRunningContext = {
  node_id: string
  session_id: string
  idle_ms: number
}

export function findPermissionWaitingFromProgress(
  state: WorkflowState,
  progressByNode: Record<string, NodeProgressEntry[]>,
  liveStatusBySession: Record<string, string> = {},
): PermissionWaitingContext | undefined {
  for (const node of state.node_runs) {
    if (node.status !== "running") continue
    const liveStatus = liveStatusBySession[node.session_id]
    const progress = progressByNode[node.id] ?? []
    const latestStatus = [...progress].reverse().find((entry) => entry.kind === "session_status")
    const waiting = liveStatus === "waiting_permission" || latestStatus?.summary.includes("waiting_permission")
    if (!waiting) continue
    return {
      session_id: node.session_id,
      node_id: node.id,
      hint: `Switch to child session ${node.session_id} and approve the pending permission request in OpenCode.`,
    }
  }
  return undefined
}

export function findStalledRunningNode(
  state: WorkflowState,
  progressByNode: Record<string, NodeProgressEntry[]>,
  now: Date = new Date(),
  thresholdMs: number = STALLED_PROGRESS_AFTER_MS,
): StalledRunningContext | undefined {
  const current = now.getTime()
  for (const node of state.node_runs) {
    if (node.status !== "running") continue
    const progress = progressByNode[node.id] ?? []
    const observedAt = progress.at(-1)?.at ?? node.started_at
    const observed = Date.parse(observedAt)
    if (!Number.isFinite(observed) || !Number.isFinite(current)) continue
    const idleMs = Math.max(0, current - observed)
    if (idleMs >= thresholdMs) {
      return {
        node_id: node.id,
        session_id: node.session_id,
        idle_ms: idleMs,
      }
    }
  }
  return undefined
}
