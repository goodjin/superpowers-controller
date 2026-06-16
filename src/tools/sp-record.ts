import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { parseSpRecordInput } from "../state/record-schema"
import { noopProgressReporter, type ProgressReporter } from "../progress/reporter"
import { decideNextDispatches, type DispatchDecision } from "../router/transition"
import { buildNodeTaskPacket } from "../session/templates"
import type { SessionOrchestrator } from "../session/orchestrator"
import type { ProjectStore } from "../state/store"
import type { NodeStatus, WorkflowState } from "../state/types"

export type RecordHandlerContext = {
  sessionID?: string
  agent?: string
}

export function createRecordHandler(deps: {
  store: ProjectStore
  orchestrator: Pick<SessionOrchestrator, "dispatch">
  progress?: ProgressReporter
}) {
  return async (input: unknown, context: RecordHandlerContext = {}): Promise<string> => {
    const progress = deps.progress ?? noopProgressReporter
    const record = parseSpRecordInput(input)
    const state = deps.store.recordNodeResult({
      input: record,
    })
    const decisions = decideNextDispatches(state, record)
    const dispatches = []

    await progress.report({
      stage: "node_recorded",
      title: "Superpowers workflow",
      message: `${record.event} recorded as ${record.status}; workflow is at ${state.current_phase ?? state.phase}.`,
      variant: variantForRecordStatus(record.status),
    })

    for (const decision of decisions) {
      if (decision.action === "wait_user") {
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
      const result = await deps.orchestrator.dispatch({
        project: current.project,
        runID: current.id,
        parentSessionID: current.parent_session_id ?? context.sessionID ?? current.session,
        decision,
        packet,
      })
      deps.store.addNodeRun({
        phase: decision.phase,
        agent: decision.agent,
        primary_skill: decision.primary_skill,
        session_id: result.session_id,
        task_id: decision.task_id,
        task_markdown: result.task_markdown,
      })
      dispatches.push({
        action: result.action,
        agent: decision.agent,
        phase: decision.phase,
        task_id: decision.task_id,
        session_id: result.session_id,
      })
    }

    return JSON.stringify(
      {
        state: deps.store.readCurrent(),
        decisions,
        dispatches,
      },
      null,
      2,
    )
  }
}

export function createRecordTool(
  store: ProjectStore,
  orchestrator: Pick<SessionOrchestrator, "dispatch"> = createNoopOrchestrator(),
  progress: ProgressReporter = noopProgressReporter,
): ToolDefinition {
  const handler = createRecordHandler({ store, orchestrator, progress })
  return tool({
    description: "Record a Superpowers node result, artifact, evidence, and validated gate update.",
    args: {
      event: tool.schema.string().describe("Node event enum: intake, question, design, plan, debug, red-test, implementation, spec-review, code-review, verification, or finish"),
      status: tool.schema.string().describe("Node status enum: passed, failed, blocked, or needs_user"),
      summary: tool.schema.string().describe("Short markdown summary of the node result"),
      gates: tool.schema.record(tool.schema.string(), tool.schema.boolean()).optional().describe("Structured gate updates keyed by known gate name"),
      artifacts: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("Markdown artifact bodies keyed by known artifact name"),
      checks: tool.schema.string().optional().describe("Markdown checks or command evidence. The plugin stores this as text."),
      findings: tool.schema.string().optional().describe("Markdown findings. The plugin stores this as text."),
      question: tool.schema
        .object({
          prompt: tool.schema.string(),
          options: tool.schema.array(tool.schema.string()).optional(),
        })
        .optional()
        .describe("Question for the user when status is needs_user"),
      task_graph: tool.schema
        .object({
          tasks: tool.schema.array(
            tool.schema.object({
              id: tool.schema.string(),
              title: tool.schema.string(),
              summary: tool.schema.string(),
              depends_on: tool.schema.array(tool.schema.string()),
              files: tool.schema.array(tool.schema.string()).optional(),
              test_commands: tool.schema.array(tool.schema.string()).optional(),
            }),
          ),
        })
        .optional()
        .describe("Plan task graph. depends_on is the only parallelism contract."),
    },
    async execute(args, context) {
      return handler(args, { sessionID: context.sessionID, agent: context.agent })
    },
  })
}

function variantForRecordStatus(status: NodeStatus): "info" | "success" | "warning" | "error" {
  switch (status) {
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

function createNoopOrchestrator(): Pick<SessionOrchestrator, "dispatch"> {
  return {
    async dispatch(args) {
      return {
        action: args.decision.action,
        session_id: args.decision.action === "reuse_session" ? args.decision.session_id : "session-dispatch-unavailable",
        task_markdown: `# Dispatch unavailable\n\n${args.packet.objective}\n`,
      }
    },
  }
}
