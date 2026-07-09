import { parseSpRecordInput } from "../state/record-schema"
import { noopProgressReporter, type ProgressReporter } from "../progress/reporter"
import { decideNextDispatches, type DispatchDecision } from "../router/transition"
import { buildControllerUserInputPrompt, buildNodeTaskPacket } from "../session/templates"
import type { SessionOrchestrator } from "../session/orchestrator"
import type { ProjectStore } from "../state/store"
import type { NodeStatus, WorkflowState } from "../state/types"
import { buildControllerFeedback } from "../controller/feedback"

export type ReportHandlerContext = {
  sessionID?: string
  agent?: string
}

export function createReportHandler(deps: {
  store: ProjectStore
  orchestrator: Pick<SessionOrchestrator, "dispatch"> & Partial<Pick<SessionOrchestrator, "notifyParent">>
  progress?: ProgressReporter
}) {
  return async (input: unknown, context: ReportHandlerContext = {}): Promise<string> => {
    const progress = deps.progress ?? noopProgressReporter
    const record = parseSpRecordInput(input)
    const state = deps.store.recordNodeResult({
      input: record,
      sessionID: context.sessionID,
      agent: context.agent,
    })
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
        const target = userInputNotificationTarget(current, context)
        if (deps.orchestrator.notifyParent) {
          try {
            await deps.orchestrator.notifyParent({
              sessionID: target.sessionID,
              agent: target.agent,
              prompt: buildControllerUserInputPrompt(current, { conversation: target.conversation }),
            })
          } catch (error) {
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
    if (current.status === "waiting_controller_decision" && deps.orchestrator.notifyParent) {
      const feedback = buildControllerFeedback(current)
      try {
        await deps.orchestrator.notifyParent({
          sessionID: current.parent_session_id,
          agent: "superpowers-agent",
          prompt: buildControllerDecisionPrompt(current, feedback.allowed_controller_decisions),
        })
      } catch (error) {
        await progress.report({
          stage: "workflow_blocked",
          title: "Superpowers workflow",
          message: `Parent controller decision notification failed: ${errorMessage(error)}`,
          variant: "error",
        })
      }
    }

    return JSON.stringify(
      {
        state: current,
        decisions,
        dispatches,
        controller_feedback: buildControllerFeedback(current),
      },
      null,
      2,
    )
  }
}

function buildControllerDecisionPrompt(
  state: WorkflowState,
  allowedControllerDecisions: ReturnType<typeof buildControllerFeedback>["allowed_controller_decisions"],
): string {
  const firstDecision = allowedControllerDecisions[0]
  return [
    "# Superpowers workflow waiting for controller decision",
    "",
    `Run: ${state.id}`,
    `Workflow: ${state.workflow}`,
    `Phase: ${state.current_phase}`,
    `Status: ${state.status}`,
    "",
    "A child node finished its `sp_report`, but the runtime cannot safely continue without a controller decision.",
    "First call `sp_status` for this run to refresh the runtime facts, then choose one of `allowed_controller_decisions` and call `sp_start(start_action=\"resolve_controller_decision\")` with that exact payload.",
    "Do not invent a decision outside `allowed_controller_decisions`.",
    "",
    "Suggested first available decision:",
    firstDecision ? `- ${firstDecision.kind}: ${firstDecision.reason}` : "- none available; call sp_status and explain the missing decision list.",
    "",
    firstDecision?.payload ? "```json" : "",
    firstDecision?.payload ? JSON.stringify(firstDecision.payload, null, 2) : "",
    firstDecision?.payload ? "```" : "",
  ].filter(Boolean).join("\n")
}

function userInputNotificationTarget(
  state: WorkflowState,
  context: ReportHandlerContext,
): {
  sessionID: string
  agent: string
  conversation: "main" | "foreground"
  label: string
} {
  const reportingNode = context.sessionID
    ? state.node_runs.find((node) => node.session_id === context.sessionID)
    : undefined
  if (reportingNode && isForegroundSerialPhase(reportingNode.phase)) {
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
