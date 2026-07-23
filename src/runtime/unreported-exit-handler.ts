import type { NodeProgressEntry } from "../progress/node-progress"
import type { ProgressReporter } from "../progress/reporter"
import type { SessionOrchestrator } from "../session/orchestrator"
import type { ProjectStore } from "../state/store"
import type { WorkflowState } from "../state/types"
import { notifyParentControllerDecision } from "./notify-controller"
import { collectSilentExitEvidence, type SilentExitReason } from "./silent-exit"
import { sessionErrorNodeStatus } from "./workflow-attention"

export type UnreportedExitHandler = {
  handle(args: {
    sessionID: string
    reason: SilentExitReason
    idle_ms?: number
    error?: unknown
  }): Promise<{ handled: boolean; node_id?: string }>
}

export function createUnreportedExitHandler(deps: {
  store: ProjectStore
  orchestrator: Pick<SessionOrchestrator, "notifyParent"> & Partial<Pick<SessionOrchestrator, "returnToParent">>
  progress: ProgressReporter
  fetchMessages: (sessionID: string) => Promise<ReadonlyArray<unknown>>
  readProgressForNode: (state: WorkflowState, nodeID: string) => NodeProgressEntry[]
}): UnreportedExitHandler {
  const handled = new Set<string>()

  return {
    async handle(args) {
      const state = deps.store.readCurrent()
      if (!state) return { handled: false }
      const node = state.node_runs.find((run) => run.session_id === args.sessionID && run.status === "running")
      if (!node) return { handled: false }

      const key = `${state.id}:${node.id}`
      if (handled.has(key)) return { handled: false }
      handled.add(key)

      const messages = await deps.fetchMessages(args.sessionID)
      const progress = deps.readProgressForNode(state, node.id)
      const evidence = collectSilentExitEvidence({
        reason: args.reason,
        messages,
        progress,
        error: args.error,
        idle_ms: args.idle_ms,
      })

      const nodeStatus = args.reason === "session_error" && args.error !== undefined
        ? sessionErrorNodeStatus(evidence.error ?? String(args.error))
        : "interrupted"
      const closed = deps.store.markUnreportedExit({
        session_id: args.sessionID,
        reason: args.reason,
        summary: evidence.summary,
        evidence: {
          assistant_text: evidence.assistant_text,
          produced_paths: evidence.produced_paths,
          collected_at: evidence.collected_at,
          error: evidence.error,
          idle_ms: evidence.idle_ms,
        },
        node_status: nodeStatus === "failed" ? "failed" : "interrupted",
      })
      if (!closed) return { handled: false }

      await deps.progress.report({
        stage: "workflow_blocked",
        title: "Superpowers workflow",
        message: `Node ${closed.node.id} ended without sp_report (${args.reason}); waiting for controller decision.`,
        variant: "warning",
      })

      const latest = deps.store.readCurrent()
      if (latest) {
        await notifyParentControllerDecision({
          store: deps.store,
          orchestrator: deps.orchestrator,
          progress: deps.progress,
          state: latest,
          silentExit: {
            ...evidence,
            artifact_path: closed.artifact_path,
          },
        })
      }

      return { handled: true, node_id: closed.node.id }
    },
  }
}
