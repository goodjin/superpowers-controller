import type { NodeProgressEntry } from "../progress/node-progress"
import type { NodeRun, WorkflowState } from "../state/types"

export const DEFAULT_LIVENESS_TIMEOUT_MS = 300_000
export const DEFAULT_LIVENESS_CHECK_INTERVAL_MS = 15_000

export type LivenessExpiredNode = {
  node: NodeRun
  idle_ms: number
}

export function findExpiredRunningNodes(args: {
  state: WorkflowState | null
  progressByNode: Record<string, NodeProgressEntry[]>
  now?: Date
  timeoutMs?: number
}): LivenessExpiredNode[] {
  const state = args.state
  if (!state) return []
  if (state.status === "passed" || state.status === "canceled") return []

  const now = args.now ?? new Date()
  const timeoutMs = args.timeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS
  const current = now.getTime()
  const expired: LivenessExpiredNode[] = []

  for (const node of state.node_runs) {
    if (node.status !== "running") continue
    const progress = args.progressByNode[node.id] ?? []
    const observedAt = progress.at(-1)?.at ?? node.started_at
    const observed = Date.parse(observedAt)
    if (!Number.isFinite(observed) || !Number.isFinite(current)) continue
    const idleMs = Math.max(0, current - observed)
    if (idleMs >= timeoutMs) {
      expired.push({ node, idle_ms: idleMs })
    }
  }

  return expired
}

export function createLivenessMonitor(args: {
  readState: () => WorkflowState | null
  readProgressByNode: (state: WorkflowState) => Record<string, NodeProgressEntry[]>
  onExpired: (entry: LivenessExpiredNode) => void
  timeoutMs?: number
  intervalMs?: number
}) {
  const timeoutMs = args.timeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS
  const intervalMs = args.intervalMs ?? DEFAULT_LIVENESS_CHECK_INTERVAL_MS
  const handled = new Set<string>()

  const timer = setInterval(() => {
    const state = args.readState()
    if (!state) return
    const progressByNode = args.readProgressByNode(state)
    for (const entry of findExpiredRunningNodes({ state, progressByNode, timeoutMs })) {
      const key = `${state.id}:${entry.node.id}`
      if (handled.has(key)) continue
      handled.add(key)
      args.onExpired(entry)
    }
  }, intervalMs)

  if (typeof timer.unref === "function") timer.unref()

  return {
    stop() {
      clearInterval(timer)
    },
  }
}
