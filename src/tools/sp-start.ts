import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { prepareExplicitStartRun } from "../controller/intake"
import { noopProgressReporter, type ProgressReporter } from "../progress/reporter"
import { decideNextDispatches } from "../router/transition"
import { buildNodeTaskPacket } from "../session/templates"
import type { SessionOrchestrator } from "../session/orchestrator"
import type { ProjectStore } from "../state/store"
import type { WorkflowEntrypoint, WorkflowKind } from "../state/types"

export function createStartTool(
  store: ProjectStore,
  orchestrator?: Pick<SessionOrchestrator, "dispatch">,
  progress: ProgressReporter = noopProgressReporter,
): ToolDefinition {
  return tool({
    description: "Activate a reviewed planning draft or start a confirmed workflow run.",
    args: {
      request: tool.schema.string().optional().describe("Confirmed user request"),
      workflow: tool.schema.string().optional().describe("Workflow kind: feature, debug, plan-only, review, verify-finish, or parallel-investigate"),
      entrypoint: tool.schema.string().optional().describe("Confirmed entrypoint"),
      proposal: tool.schema.string().optional().describe("Proposal markdown that was confirmed by the user"),
      run_id: tool.schema.string().optional().describe("Prepared run id to activate after plan review"),
      task_id: tool.schema.string().optional().describe("Optional task id to resume when activating a prepared plan"),
      session: tool.schema.string().optional().describe("Controller session id"),
    },
    async execute(args, context) {
      const sessionID = args.session ?? context.sessionID
      let state
      let dispatches: Array<Record<string, string | undefined>> = []
      let startMode: "new" | "resume" = "new"
      if (args.run_id) {
        state = store.activateRun({
          runID: args.run_id,
          parentSessionID: sessionID,
        })
        startMode = "resume"
      } else {
        if (!args.request || !args.workflow || !args.entrypoint || !args.proposal) {
          throw new Error("sp_start requires request, workflow, entrypoint, and proposal when run_id is not provided.")
        }
        const start = prepareExplicitStartRun({
          request: args.request,
          workflow: args.workflow as WorkflowKind,
          entrypoint: args.entrypoint as WorkflowEntrypoint,
          proposal: args.proposal,
          parentSessionID: sessionID,
        })
        state = store.startRun(start)
      }
      dispatches = await dispatchStart({
        store,
        orchestrator,
        state,
        taskID: args.task_id,
        startMode,
      })
      await progress.report({
        stage: "run_started",
        title: "Superpowers workflow",
        message: `${state.workflow} workflow run started from ${state.entrypoint}.`,
        variant: "success",
      })
      return JSON.stringify(
        {
          state,
          dispatches: dispatches.length > 0 ? dispatches : startDecisions(state, startMode),
        },
        null,
        2,
      )
    },
  })
}

async function dispatchStart(args: {
  store: ProjectStore
  orchestrator?: Pick<SessionOrchestrator, "dispatch">
  state: ReturnType<ProjectStore["activateRun"]>
  taskID?: string
  startMode: "new" | "resume"
}): Promise<Array<Record<string, string | undefined>>> {
  if (!args.orchestrator) return []
  const decisions = startDecisions(args.state, args.startMode)
  const filtered = args.taskID
    ? decisions.filter((decision) => "task_id" in decision && decision.task_id === args.taskID)
    : decisions
  const dispatches: Array<Record<string, string | undefined>> = []
  for (const decision of filtered) {
    if (decision.action !== "create_session" && decision.action !== "reuse_session") continue
    const current = args.store.readCurrent() ?? args.state
    const packet = buildNodeTaskPacket({
      state: current,
      decision,
      nodeID: nextDispatchNodeID(current.node_runs.length + dispatches.length + 1, decision.phase, decision.task_id),
    })
    let nodeRegistered = false
    const result = await args.orchestrator.dispatch({
      project: current.project,
      runID: current.id,
      parentSessionID: current.parent_session_id,
      decision,
      packet,
      async onSessionCreated(input) {
        args.store.addNodeRun({
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
    if (!nodeRegistered) {
      args.store.addNodeRun({
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
      phase: decision.phase,
      agent: decision.agent,
      task_id: decision.task_id,
      session_id: result.session_id,
    })
  }
  return dispatches
}

function startDecisions(state: ReturnType<ProjectStore["activateRun"]>, startMode: "new" | "resume" = "new") {
  if (startMode === "resume") return decideNextDispatches(state)
  if (state.task_graph?.tasks.length && state.current_phase === "plan-complete") {
    return decideNextDispatches(state, {
      event: "plan",
      status: "passed",
      summary: "Plan approved for execution.",
    })
  }
  return decideNextDispatches(state, {
    event: "intake",
    status: "passed",
    summary: "Workflow start confirmed.",
  })
}

function nextDispatchNodeID(index: number, phase: string, taskID?: string): string {
  const task = taskID ? `-${taskID}` : ""
  return `${String(index).padStart(3, "0")}-${phase}${task}`
}
