import { parseSpRecordInput } from "../state/record-schema"
import { noopProgressReporter, type ProgressReporter } from "../progress/reporter"
import { decideNextDispatches, type DispatchDecision } from "../router/transition"
import { buildControllerUserInputPrompt, buildNodeTaskPacket } from "../session/templates"
import { notifyParentControllerDecision } from "../runtime/notify-controller"
import type { SessionOrchestrator } from "../session/orchestrator"
import type { ProjectStore } from "../state/store"
import type { NodeStatus, WorkflowState } from "../state/types"
import { buildControllerFeedback } from "../controller/feedback"
import type { WorkflowConfig } from "../config/schema"
import { DEFAULT_CONFIG } from "../config/defaults"
import { resolveInteractionMode, shouldRouteUserInputToParent } from "../config/interaction"
import { validateQualityGateForRecord } from "../runtime/quality-checks"

export type ReportHandlerContext = {
  sessionID?: string
  agent?: string
}

export function createReportHandler(deps: {
  store: ProjectStore
  orchestrator: Pick<SessionOrchestrator, "dispatch"> & Partial<Pick<SessionOrchestrator, "notifyParent">>
  progress?: ProgressReporter
  config?: WorkflowConfig
}) {
  return async (input: unknown, context: ReportHandlerContext = {}): Promise<string> => {
    const progress = deps.progress ?? noopProgressReporter
    const record = parseSpRecordInput(input)
    const currentBeforeRecord = deps.store.readCurrent()
    if (currentBeforeRecord && deps.config) {
      validateQualityGateForRecord({
        config: deps.config,
        state: currentBeforeRecord,
        record,
        nodeID: resolveReportingNodeID(currentBeforeRecord, record, context),
      })
    }
    const state = deps.store.recordNodeResult({
      input: record,
      sessionID: context.sessionID,
      agent: context.agent,
    })
    if (deps.store.lastRecordOutcome()?.lateIgnored) {
      await progress.report({
        stage: "node_recorded",
        title: "Superpowers workflow",
        message: `${record.event} late report ignored; workflow stays at ${state.current_phase ?? state.phase}.`,
        variant: "warning",
      })
      return JSON.stringify(
        {
          state,
          decisions: [],
          dispatches: [],
          late_report_ignored: true,
          controller_feedback: buildControllerFeedback(state, {
            blocking_reason: "This session is no longer the running node. If the workflow is waiting_user, answer in the parent controller session (or rely on the child-answer bridge) instead of calling sp_report again.",
          }),
        },
        null,
        2,
      )
    }
    const decisions = decideNextDispatches(state, record)
    const dispatches = []

    await progress.report({
      stage: "node_recorded",
      title: "Superpowers workflow",
      message: `${record.event} reported as ${record.status}; workflow is at ${state.current_phase ?? state.phase}.`,
      variant: variantForReportStatus(record.status),
    })

    for (const decision of decisions) {
      if (decision.action === "wait_user") {
        const current = deps.store.readCurrent() ?? state
        const interactionMode = resolveInteractionMode(deps.config ?? DEFAULT_CONFIG)
        const target = userInputNotificationTarget(current, context, interactionMode)
        if (deps.orchestrator.notifyParent) {
          try {
            await deps.orchestrator.notifyParent({
              sessionID: target.sessionID,
              agent: target.agent,
              prompt: buildControllerUserInputPrompt(current, { conversation: target.conversation }),
              selectSession: true,
            })
          } catch (error) {
            const current = deps.store.readCurrent() ?? state
            const sourceNode = current.pending_question?.source_node_id
              ? current.node_runs.find((node) => node.id === current.pending_question?.source_node_id)
              : undefined
            if (sourceNode) {
              deps.store.markNotificationFailed({
                node_id: sourceNode.id,
                error,
              })
            }
            await progress.report({
              stage: "workflow_blocked",
              title: "Superpowers workflow",
              message: `${target.label} notification failed: ${errorMessage(error)}`,
              variant: "error",
            })
          }
        }
        await progress.report({
          stage: "waiting_user_input",
          title: "Superpowers workflow",
          message: "Node requested user input.",
          variant: "warning",
        })
        continue
      }
      if (decision.action === "blocked") {
        await progress.report({
          stage: "workflow_blocked",
          title: "Superpowers workflow",
          message: `Workflow blocked: ${decision.reason}`,
          variant: "error",
        })
        continue
      }
      if (decision.action === "finish") {
        await progress.report({
          stage: "workflow_finished",
          title: "Superpowers workflow",
          message: "Workflow finished.",
          variant: "success",
        })
        continue
      }
      if (decision.action !== "create_session" && decision.action !== "reuse_session") continue
      const current = deps.store.readCurrent() ?? state
      const nodeID = nextDispatchNodeID(current, decision)
      const packet = buildNodeTaskPacket({
        state: current,
        decision,
        nodeID,
        config: deps.config,
      })
      let nodeRegistered = false
      let result
      try {
        result = await deps.orchestrator.dispatch({
          project: current.project,
          runID: current.id,
          parentSessionID: current.parent_session_id ?? context.sessionID ?? current.session,
          decision,
          packet,
          readStateForProgress: () => deps.store.readRun(current.id),
          async onSessionCreated(input) {
            deps.store.addNodeRun({
              phase: decision.phase,
              agent: decision.agent,
              primary_skill: decision.primary_skill,
              session_id: input.sessionID,
              task_id: decision.task_id,
              task_markdown: input.taskMarkdown,
            })
            nodeRegistered = true
          },
          async onPromptDeliveryFailed(input) {
            deps.store.markPromptDeliveryFailed({
              session_id: input.sessionID,
              error: input.error,
            })
          },
        })
      } catch (error) {
        deps.store.markDispatchFailed({
          phase: decision.phase,
          agent: decision.agent,
          primary_skill: decision.primary_skill,
          task_id: decision.task_id,
          error,
        })
        dispatches.push({
          action: "dispatch_failed",
          agent: decision.agent,
          phase: decision.phase,
          task_id: decision.task_id,
        })
        continue
      }
      if (!nodeRegistered) {
        deps.store.addNodeRun({
          phase: decision.phase,
          agent: decision.agent,
          primary_skill: decision.primary_skill,
          session_id: result.session_id,
          task_id: decision.task_id,
          task_markdown: result.task_markdown,
        })
      }
      dispatches.push({
        action: result.action,
        agent: decision.agent,
        phase: decision.phase,
        task_id: decision.task_id,
        session_id: result.session_id,
      })
    }

    const current = deps.store.readCurrent() ?? state
    let feedbackOverride: Partial<ReturnType<typeof buildControllerFeedback>> | undefined
    if (current.status === "waiting_controller_decision" && deps.orchestrator.notifyParent) {
      const notified = await notifyParentControllerDecision({
        store: deps.store,
        orchestrator: { notifyParent: deps.orchestrator.notifyParent },
        progress,
        state: current,
      })
      if (!notified.ok) {
        feedbackOverride = {
          blocking_reason: `Parent controller decision notification failed: ${notified.error}. Call sp_status and submit sp_start(resolve_controller_decision) manually.`,
        }
      }
    }

    const latest = deps.store.readCurrent() ?? current
    return JSON.stringify(
      {
        state: latest,
        decisions,
        dispatches,
        controller_feedback: buildControllerFeedback(latest, feedbackOverride),
      },
      null,
      2,
    )
  }
}

function userInputNotificationTarget(
  state: WorkflowState,
  context: ReportHandlerContext,
  interactionMode: ReturnType<typeof resolveInteractionMode>,
): {
  sessionID: string
  agent: string
  conversation: "main" | "foreground"
  label: string
} {
  const reportingNode = context.sessionID
    ? state.node_runs.find((node) => node.session_id === context.sessionID)
    : undefined
  const canUseForegroundChild = Boolean(
    reportingNode && isForegroundSerialPhase(reportingNode.phase) && !shouldRouteUserInputToParent(interactionMode),
  )
  if (canUseForegroundChild && reportingNode) {
    return {
      sessionID: reportingNode.session_id,
      agent: reportingNode.agent,
      conversation: "foreground",
      label: "Foreground child",
    }
  }
  return {
    sessionID: state.parent_session_id,
    agent: "superpowers-agent",
    conversation: "main",
    label: "Parent",
  }
}

function isForegroundSerialPhase(phase: string): boolean {
  return phase === "design" || phase === "plan"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Unknown error."
}

function variantForReportStatus(status: NodeStatus): "info" | "success" | "warning" | "error" {
  switch (status) {
    case "progress":
      return "info"
    case "passed":
      return "success"
    case "needs_user":
      return "warning"
    case "blocked":
    case "failed":
      return "error"
  }
}

function nextDispatchNodeID(state: WorkflowState, decision: Extract<DispatchDecision, { action: "create_session" | "reuse_session" }>): string {
  const index = state.node_runs.length + 1
  const task = decision.task_id ? `-${decision.task_id}` : ""
  return `${String(index).padStart(3, "0")}-${decision.phase}${task}`
}

function resolveReportingNodeID(
  state: WorkflowState,
  record: { event: string },
  context: ReportHandlerContext,
): string | undefined {
  const running = state.node_runs.filter((run) => run.status === "running")
  if (context.sessionID) {
    const matches = running.filter((run) => run.session_id === context.sessionID)
    if (matches.length === 1) return matches[0]!.id
  }
  const phase = record.event === "finish" ? "finish" : record.event === "verification" ? "verification" : undefined
  if (phase) {
    const matches = running.filter((run) => run.phase === phase)
    if (matches.length === 1) return matches[0]!.id
  }
  if (running.length === 1) return running[0]!.id
  return undefined
}
