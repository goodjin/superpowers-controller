import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { prepareExplicitStartRun } from "../controller/intake"
import { noopProgressReporter, type ProgressReporter } from "../progress/reporter"
import { AGENT_SKILL_MAP, type NodeAgentName } from "../router/modes"
import { decideNextDispatches } from "../router/transition"
import { buildChildResumePrompt, buildNodeTaskPacket } from "../session/templates"
import type { SessionOrchestrator } from "../session/orchestrator"
import type { ProjectStore } from "../state/store"
import type { ControllerDecision, ResumeInput, StartAction, WorkflowEntrypoint, WorkflowKind, WorkflowOrchestration, WorkflowSpec, WorkflowState } from "../state/types"
import { buildAllowedControllerDecisions, buildControllerFeedback, inferStartAction, staleStateFeedback } from "../controller/feedback"
import { createWorkflowSpec, findBuiltInWorkflowTemplate } from "../capabilities/workflows"

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
      prepared_task_id: tool.schema.string().optional().describe("V5 alias for run_id."),
      action: tool.schema.enum(["start_prepared_task", "start_entrypoint", "approve_design", "approve_plan", "resume_user_input", "retry_node", "resolve_controller_decision"]).optional().describe("V5 explicit action. start_prepared_task aliases start_entrypoint."),
      start_action: tool.schema.enum(["start_prepared_task", "start_entrypoint", "approve_design", "approve_plan", "resume_user_input", "retry_node", "resolve_controller_decision"]).optional().describe("Explicit start action."),
      start_config: tool.schema
        .object({
          kind: tool.schema.enum(["built_in_workflow", "orchestration"]).describe("Whether to use a built-in template or controller-provided orchestration."),
          workflow_id: tool.schema.string().optional().describe("Built-in workflow id."),
          auto_expansion: tool.schema
            .object({
              allow: tool.schema.boolean().optional(),
              reason: tool.schema.string().optional(),
            })
            .optional()
            .describe("Override template auto expansion policy."),
          orchestration: tool.schema
            .object({
              id: tool.schema.string().optional(),
              title: tool.schema.string().optional(),
              nodes: tool.schema.array(
                tool.schema.object({
                  id: tool.schema.string(),
                  title: tool.schema.string().optional(),
                  agent: tool.schema.string(),
                  phase: tool.schema.string().optional(),
                  task_id: tool.schema.string().optional(),
                  depends_on: tool.schema.array(tool.schema.string()).optional(),
                  input_documents: tool.schema.array(tool.schema.string()).optional(),
                  output_documents: tool.schema.array(tool.schema.string()).optional(),
                  report_contract: tool.schema.array(tool.schema.string()).optional(),
                }),
              ),
            })
            .optional()
            .describe("Controller-provided workflow orchestration. It may contain a single node."),
        })
        .optional()
        .describe("V5 workflow start configuration."),
      expected_state_version: tool.schema.string().optional().describe("Optional optimistic concurrency guard for approval or retry actions."),
      task_id: tool.schema.string().optional().describe("Optional task id to resume when activating a prepared plan"),
      session: tool.schema.string().optional().describe("Controller session id"),
      controller_decision: tool.schema
        .object({
          kind: tool.schema.enum(["continue_existing_graph", "retry_node", "accept_partial_result", "mark_blocked", "request_reprepare", "apply_workflow_patch", "replace_orchestration"]).describe("Controller decision kind"),
          node_id: tool.schema.string().optional().describe("Node id the decision targets"),
          task_id: tool.schema.string().optional().describe("Task id the decision targets"),
          reason: tool.schema.string().optional().describe("Controller-facing reason for this decision"),
          evidence_refs: tool.schema.array(tool.schema.string()).optional().describe("Durable evidence refs accepted by the controller"),
          required_user_action: tool.schema.string().optional().describe("User action required after mark_blocked"),
          reuse_session: tool.schema.boolean().optional().describe("Whether the controller expects session reuse"),
          workflow_patch: tool.schema
            .object({
              mode: tool.schema.enum(["append", "replace"]).optional(),
              reason: tool.schema.string().optional(),
              tasks: tool.schema
                .array(
                  tool.schema.object({
                    id: tool.schema.string(),
                    title: tool.schema.string(),
                    summary: tool.schema.string(),
                    depends_on: tool.schema.array(tool.schema.string()),
                    agent: tool.schema.string().optional(),
                    files: tool.schema.array(tool.schema.string()).optional(),
                    test_commands: tool.schema.array(tool.schema.string()).optional(),
                  }),
                )
                .optional(),
              nodes: tool.schema
                .array(
                  tool.schema.object({
                    id: tool.schema.string(),
                    title: tool.schema.string().optional(),
                    agent: tool.schema.string(),
                    phase: tool.schema.string().optional(),
                    task_id: tool.schema.string().optional(),
                    depends_on: tool.schema.array(tool.schema.string()).optional(),
                    input_documents: tool.schema.array(tool.schema.string()).optional(),
                    output_documents: tool.schema.array(tool.schema.string()).optional(),
                    report_contract: tool.schema.array(tool.schema.string()).optional(),
                  }),
                )
                .optional(),
            })
            .optional()
            .describe("Workflow expansion patch selected by controller."),
          orchestration: tool.schema
            .object({
              id: tool.schema.string().optional(),
              title: tool.schema.string().optional(),
              nodes: tool.schema.array(
                tool.schema.object({
                  id: tool.schema.string(),
                  title: tool.schema.string().optional(),
                  agent: tool.schema.string(),
                  phase: tool.schema.string().optional(),
                  task_id: tool.schema.string().optional(),
                  depends_on: tool.schema.array(tool.schema.string()).optional(),
                  input_documents: tool.schema.array(tool.schema.string()).optional(),
                  output_documents: tool.schema.array(tool.schema.string()).optional(),
                  report_contract: tool.schema.array(tool.schema.string()).optional(),
                }),
              ),
            })
            .optional()
            .describe("Replacement orchestration selected by controller."),
        })
        .optional()
        .describe("Decision chosen by the controller from allowed_controller_decisions."),
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
      const callerSessionID = args.session ?? context.sessionID
      const runID = args.run_id ?? args.prepared_task_id
      const currentForVersion = runID ? store.readRun(runID) : store.readCurrent()
      const parentSessionID = currentForVersion?.parent_session_id ?? callerSessionID
      const currentStateVersion = currentForVersion?.state_version ?? (currentForVersion ? `${currentForVersion.updated_at}:legacy` : undefined)
      if (args.expected_state_version && currentForVersion && args.expected_state_version !== currentStateVersion) {
        return JSON.stringify(
          {
            state: currentForVersion,
            dispatches: [],
            controller_feedback: staleStateFeedback(currentForVersion, args.expected_state_version),
          },
          null,
          2,
        )
      }
      const requestedAction = normalizeStartAction((args.action ?? args.start_action) as StartAction | undefined)
      const startAction = currentForVersion ? inferStartAction(currentForVersion, {
        start_action: requestedAction,
        resume_input: args.resume_input,
        task_id: args.task_id,
      }) : requestedAction ?? "start_entrypoint"

      if (startAction === "resolve_controller_decision") {
        if (!runID) throw new Error("sp_start resolve_controller_decision requires run_id or prepared_task_id.")
        if (!args.controller_decision) throw new Error("sp_start resolve_controller_decision requires controller_decision.")
        const current = store.readRun(runID)
        if (!current) throw new Error(`No Superpowers workflow found for run ${runID}.`)
        const decision = args.controller_decision as ControllerDecision
        if (!isAllowedControllerDecision(current, decision)) {
          return JSON.stringify(
            {
              state: current,
              dispatches: [],
              start_action: startAction,
              controller_feedback: buildControllerFeedback(current, {
                outcome: "blocked",
                blocking_reason: `controller_decision ${decision.kind} is not allowed for status ${current.status}.`,
              }),
            },
            null,
            2,
          )
        }
        const result = await resolveControllerDecision({
          store,
          orchestrator,
          parentSessionID,
          state: current,
          decision,
        })
        await progress.report({
          stage: "controller_decision_resolved",
          title: "Superpowers workflow",
          message: `${current.workflow} workflow resolved controller decision ${decision.kind}.`,
          variant: result.dispatches.length > 0 ? "success" : "info",
        })
        const fresh = store.readCurrent() ?? result.state
        return JSON.stringify(
          {
            state: fresh,
            dispatches: result.dispatches,
            start_action: startAction,
            controller_feedback: buildControllerFeedback(fresh),
          },
          null,
          2,
        )
      }

      if (startAction === "resume_user_input" || args.resume_input) {
        if (!runID) throw new Error("sp_start resume_input requires run_id or prepared_task_id.")
        if (!orchestrator?.resumeNode) throw new Error("sp_start resume_input requires a session orchestrator with resumeNode.")
        if (!args.resume_input) throw new Error("sp_start resume_user_input requires resume_input.")
        const before = store.readRun(runID)
        const pendingQuestion = before?.pending_question
        const resumed = store.consumePendingQuestion({
          runID,
          parentSessionID,
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
            start_action: startAction,
            controller_feedback: buildControllerFeedback(store.readCurrent() ?? resumed.state),
          },
          null,
          2,
        )
      }
      let state
      let dispatches: Array<Record<string, string | undefined>> = []
      let startMode: "new" | "resume" = "new"
      if (runID) {
        startMode = "resume"
        if (startAction === "approve_design") {
          state = store.approveDesign({
            runID,
            parentSessionID,
            approvedBySessionID: callerSessionID,
          })
          dispatches = await dispatchStart({
            store,
            orchestrator,
            state,
            startMode,
            decisions: [createPlanDecision()],
          })
        } else if (startAction === "approve_plan") {
          state = store.approvePlan({
            runID,
            parentSessionID,
            approvedBySessionID: callerSessionID,
          })
          dispatches = await dispatchStart({
            store,
            orchestrator,
            state,
            taskID: args.task_id,
            startMode,
          })
        } else {
          state = store.activateRun({
            runID,
            parentSessionID,
          })
        }
      } else {
        if (!args.request || !args.workflow || !args.entrypoint || !args.proposal) {
          throw new Error("sp_start requires request, workflow, entrypoint, and proposal when run_id is not provided.")
        }
        const start = prepareExplicitStartRun({
          request: args.request,
          workflow: args.workflow as WorkflowKind,
          entrypoint: args.entrypoint as WorkflowEntrypoint,
          proposal: args.proposal,
          parentSessionID,
        })
        state = store.startRun(start)
      }
      const workflowSpec = buildWorkflowSpecFromStartConfig({
        runID: state.id,
        startConfig: args.start_config,
        fallbackWorkflow: state.workflow,
      })
      if (workflowSpec) {
        state = store.setWorkflowSpec({
          runID: state.id,
          parentSessionID,
          workflowSpec,
          workflow: workflowSpec.template_id ?? state.workflow,
          entrypoint: entrypointForWorkflowSpec(workflowSpec, state.entrypoint),
        })
      }
      if (dispatches.length === 0 && startAction !== "approve_design" && startAction !== "approve_plan") {
        dispatches = await dispatchStart({
          store,
          orchestrator,
          state,
          taskID: args.task_id,
          startMode,
        })
      }
      await progress.report({
        stage: "run_started",
        title: "Superpowers workflow",
        message: `${state.workflow} workflow run started from ${state.entrypoint}.`,
        variant: "success",
      })
      return JSON.stringify(
        {
          state: store.readCurrent() ?? state,
          dispatches: dispatches.length > 0 ? dispatches : startDecisions(state, startMode, args.task_id),
          start_action: startAction,
          controller_feedback: buildControllerFeedback(store.readCurrent() ?? state),
        },
        null,
        2,
      )
    },
  })
}

export async function dispatchWorkflowDecisions(args: {
  store: ProjectStore
  orchestrator?: Pick<SessionOrchestrator, "dispatch">
  state: WorkflowState
  taskID?: string
  startMode: "new" | "resume"
  decisions?: ReturnType<typeof startDecisions>
}): Promise<Array<Record<string, string | undefined>>> {
  if (!args.orchestrator) return []
  const decisions = args.decisions ?? startDecisions(args.state, args.startMode, args.taskID)
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
    let result
    try {
      result = await args.orchestrator.dispatch({
        project: current.project,
        runID: current.id,
        parentSessionID: current.parent_session_id,
        decision,
        packet,
        readStateForProgress: () => args.store.readRun(current.id),
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
    } catch (error) {
      args.store.markDispatchFailed({
        phase: decision.phase,
        agent: decision.agent,
        primary_skill: decision.primary_skill,
        task_id: decision.task_id,
        error,
      })
      dispatches.push({
        action: "dispatch_failed",
        phase: decision.phase,
        agent: decision.agent,
        task_id: decision.task_id,
      })
      continue
    }
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

const dispatchStart = dispatchWorkflowDecisions

async function resolveControllerDecision(args: {
  store: ProjectStore
  orchestrator?: StartOrchestrator
  parentSessionID: string
  state: WorkflowState
  decision: ControllerDecision
}): Promise<{ state: WorkflowState; dispatches: Array<Record<string, string | undefined>> }> {
  switch (args.decision.kind) {
    case "retry_node": {
      const state = args.store.resolveControllerDecision({
        runID: args.state.id,
        parentSessionID: args.parentSessionID,
        decision: args.decision,
      })
      const dispatches = await dispatchStart({
        store: args.store,
        orchestrator: args.orchestrator,
        state,
        startMode: "resume",
        decisions: [retryDecisionForNode(args.state, args.decision.node_id ?? args.decision.task_id)],
      })
      return { state: args.store.readCurrent() ?? state, dispatches }
    }
    case "continue_existing_graph": {
      const state = args.store.resolveControllerDecision({
        runID: args.state.id,
        parentSessionID: args.parentSessionID,
        decision: args.decision,
      })
      const dispatches = await dispatchStart({
        store: args.store,
        orchestrator: args.orchestrator,
        state,
        startMode: "resume",
      })
      return { state: args.store.readCurrent() ?? state, dispatches }
    }
    case "accept_partial_result":
    case "mark_blocked":
    case "request_reprepare":
    case "apply_workflow_patch":
    case "replace_orchestration": {
      const state = args.store.resolveControllerDecision({
        runID: args.state.id,
        parentSessionID: args.parentSessionID,
        decision: args.decision,
      })
      return { state, dispatches: [] }
    }
  }
}

function isAllowedControllerDecision(state: WorkflowState, decision: ControllerDecision): boolean {
  const allowed = buildAllowedControllerDecisions(state)
  return allowed.some((option) => {
    if (option.kind !== decision.kind) return false
    const payloadDecision = (option.payload.controller_decision ?? {}) as ControllerDecision
    if (payloadDecision.node_id && decision.node_id && payloadDecision.node_id !== decision.node_id) return false
    if (payloadDecision.task_id && decision.task_id && payloadDecision.task_id !== decision.task_id) return false
    return true
  })
}

function startDecisions(state: WorkflowState, startMode: "new" | "resume" = "new", taskID?: string) {
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

function interruptedRetryDecision(state: WorkflowState, taskID: string) {
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

function retryDecisionForNode(state: WorkflowState, nodeIDOrTaskID?: string) {
  const retryableStatuses = new Set(["interrupted", "dispatch_failed", "failed", "blocked", "notification_failed", "needs_user"])
  const node = [...state.node_runs]
    .reverse()
    .find((run) => {
      if (!retryableStatuses.has(run.status)) return false
      if (!nodeIDOrTaskID) return true
      return run.id === nodeIDOrTaskID || run.task_id === nodeIDOrTaskID
    })
  if (!node) {
    throw new Error(`No retryable node found for ${nodeIDOrTaskID ?? "latest failed node"}.`)
  }
  if (!isNodeAgentName(node.agent)) {
    throw new Error(`Cannot retry node ${node.id}: unknown agent ${node.agent}.`)
  }
  return {
    action: "create_session" as const,
    phase: node.phase,
    agent: node.agent,
    primary_skill: node.primary_skill ?? AGENT_SKILL_MAP[node.agent],
    task_id: node.task_id,
    reason: `controller retry node ${node.id}`,
  }
}

function createPlanDecision() {
  return {
    action: "create_session" as const,
    phase: "plan",
    agent: "sp-planner" as const,
    primary_skill: AGENT_SKILL_MAP["sp-planner"],
    reason: "approved design is ready for planning",
  }
}

function isNodeAgentName(agent: string): agent is NodeAgentName {
  return agent in AGENT_SKILL_MAP
}

function normalizeStartAction(action: StartAction | undefined): StartAction | undefined {
  if (action === "start_prepared_task") return "start_entrypoint"
  return action
}

type StartConfigInput = {
  kind?: "built_in_workflow" | "orchestration"
  workflow_id?: string
  auto_expansion?: {
    allow?: boolean
    reason?: string
  }
  orchestration?: WorkflowOrchestration
}

function buildWorkflowSpecFromStartConfig(args: {
  runID: string
  startConfig: unknown
  fallbackWorkflow: WorkflowKind
}): WorkflowSpec | undefined {
  const config = normalizeStartConfig(args.startConfig)
  if (!config) {
    return undefined
  }
  if (config.kind === "built_in_workflow") {
    const template = findBuiltInWorkflowTemplate(config.workflow_id)
    if (!template) throw new Error(`Unknown built-in workflow template: ${config.workflow_id ?? "(missing workflow_id)"}.`)
    return createWorkflowSpec({
      id: `${args.runID}-workflow-spec`,
      kind: "built_in_workflow",
      templateID: template.id,
      orchestration: template.orchestration,
      autoExpansionAllow: config.auto_expansion?.allow,
      autoExpansionReason: config.auto_expansion?.reason,
    })
  }
  if (!config.orchestration?.nodes?.length) {
    throw new Error("sp_start start_config.kind=orchestration requires orchestration.nodes.")
  }
  return createWorkflowSpec({
    id: `${args.runID}-workflow-spec`,
    kind: "orchestration",
    title: config.orchestration.title,
    orchestration: config.orchestration,
    autoExpansionAllow: config.auto_expansion?.allow ?? false,
    autoExpansionReason: config.auto_expansion?.reason ?? "Controller-provided orchestration defaults to bounded unless explicitly allowed.",
  })
}

function normalizeStartConfig(value: unknown): StartConfigInput | undefined {
  if (!value || typeof value !== "object") return undefined
  const input = value as StartConfigInput
  if (!input.kind) return undefined
  return input
}

function entrypointForWorkflowSpec(spec: WorkflowSpec, fallback: WorkflowEntrypoint): WorkflowEntrypoint {
  const first = spec.orchestration.nodes[0]
  const phase = first?.phase ?? first?.id
  if (isWorkflowEntrypoint(phase)) return phase
  return fallback
}

function isWorkflowEntrypoint(value: string | undefined): value is WorkflowEntrypoint {
  if (!value) return false
  return [
    "feature",
    "bugfix",
    "debug",
    "design-only",
    "plan-only",
    "review",
    "review-only",
    "verify-finish",
    "parallel-investigate",
    "single-agent",
    "design",
    "plan",
    "execute",
    "debug",
    "review",
    "verify",
    "investigate",
    "implement",
  ].includes(value)
}

function nextDispatchNodeID(index: number, phase: string, taskID?: string): string {
  const task = taskID ? `-${taskID}` : ""
  return `${String(index).padStart(3, "0")}-${phase}${task}`
}
