import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { prepareExplicitStartRun } from "../controller/intake"
import { noopProgressReporter, type ProgressReporter } from "../progress/reporter"
import { AGENT_SKILL_MAP, type NodeAgentName } from "../router/modes"
import { decideNextDispatches } from "../router/transition"
import { buildChildResumePrompt, buildNodeTaskPacket } from "../session/templates"
import type { SessionOrchestrator } from "../session/orchestrator"
import type { ProjectStore } from "../state/store"
import type { ResumeInput, WorkflowEntrypoint, WorkflowKind } from "../state/types"

type StartOrchestrator = Pick<SessionOrchestrator, "dispatch"> & Partial<Pick<SessionOrchestrator, "resumeNode">>

export function createStartTool(
  store: ProjectStore,
  orchestrator?: StartOrchestrator,
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
      resume_input: tool.schema
        .object({
          source_node_id: tool.schema.string().describe("Node id that produced the current pending_question"),
          answer_text: tool.schema.string().optional().describe("User answer as normalized free text"),
          selected_options: tool.schema.array(tool.schema.string()).optional().describe("Selected option labels when the question offered options"),
          user_message: tool.schema.string().optional().describe("Original user reply from the main conversation"),
        })
        .optional()
        .describe("User input collected by the controller for a waiting_user workflow."),
    },
    async execute(args, context) {
      const sessionID = args.session ?? context.sessionID
      if (args.resume_input) {
        if (!args.run_id) throw new Error("sp_start resume_input requires run_id.")
        if (!orchestrator?.resumeNode) throw new Error("sp_start resume_input requires a session orchestrator with resumeNode.")
        const before = store.readRun(args.run_id)
        const pendingQuestion = before?.pending_question
        const resumed = store.consumePendingQuestion({
          runID: args.run_id,
          parentSessionID: sessionID,
          resumeInput: args.resume_input as ResumeInput,
        })
        const prompt = buildChildResumePrompt({
          state: resumed.state,
          node: resumed.node,
          resumeInput: args.resume_input as ResumeInput,
          pendingQuestion,
        })
        const result = await orchestrator.resumeNode({
          sessionID: resumed.node.session_id,
          agent: resumed.node.agent,
          prompt,
        })
        await progress.report({
          stage: "run_resumed",
          title: "Superpowers workflow",
          message: `${resumed.state.workflow} workflow resumed from user input.`,
          variant: "success",
        })
        return JSON.stringify(
          {
            state: store.readCurrent() ?? resumed.state,
            dispatches: [
              {
                action: result.action,
                phase: resumed.node.phase,
                agent: resumed.node.agent,
                task_id: resumed.node.task_id,
                session_id: result.session_id,
              },
            ],
          },
          null,
          2,
        )
      }
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
          dispatches: dispatches.length > 0 ? dispatches : startDecisions(state, startMode, args.task_id),
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
  const decisions = startDecisions(args.state, args.startMode, args.taskID)
  const filtered = args.taskID && args.state.status !== "recovered_unknown"
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

function startDecisions(state: ReturnType<ProjectStore["activateRun"]>, startMode: "new" | "resume" = "new", taskID?: string) {
  if (startMode === "resume" && state.status === "recovered_unknown" && taskID) {
    return [interruptedRetryDecision(state, taskID)]
  }
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

function interruptedRetryDecision(state: ReturnType<ProjectStore["activateRun"]>, taskID: string) {
  const node = [...state.node_runs]
    .reverse()
    .find((run) => run.status === "interrupted" && (run.task_id === taskID || run.id === taskID))
  if (!node) {
    throw new Error(`No interrupted node found for task_id ${taskID}.`)
  }
  if (!isNodeAgentName(node.agent)) {
    throw new Error(`Cannot retry interrupted node ${node.id}: unknown agent ${node.agent}.`)
  }
  return {
    action: "create_session" as const,
    phase: node.phase,
    agent: node.agent,
    primary_skill: node.primary_skill ?? AGENT_SKILL_MAP[node.agent],
    task_id: node.task_id,
    reason: `retry interrupted node ${node.id}`,
  }
}

function isNodeAgentName(agent: string): agent is NodeAgentName {
  return agent in AGENT_SKILL_MAP
}

function nextDispatchNodeID(index: number, phase: string, taskID?: string): string {
  const task = taskID ? `-${taskID}` : ""
  return `${String(index).padStart(3, "0")}-${phase}${task}`
}
