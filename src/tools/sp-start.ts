import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { noopProgressReporter, type ProgressReporter } from "../progress/reporter"
import { AGENT_SKILL_MAP, type NodeAgentName } from "../router/modes"
import { decideNextDispatches } from "../router/transition"
import { dispatchDecisionForSpecNodeID } from "../router/workflow-spec-dispatch"
import { buildChildResumePrompt, buildNodeTaskPacket } from "../session/templates"
import type { SessionOrchestrator } from "../session/orchestrator"
import type { ProjectStore } from "../state/store"
import type { ControllerDecision, ResumeInput, StartAction, WorkflowEntrypoint, WorkflowKind, WorkflowOrchestration, WorkflowSpec, WorkflowState } from "../state/types"
import { buildAllowedControllerDecisions, buildControllerFeedback, inferStartAction, staleStateFeedback } from "../controller/feedback"
import { createWorkflowSpec, findBuiltInWorkflowTemplate } from "../capabilities/workflows"
import {
  decideTaskResumeDispatches,
  parseResumeTaskIDs,
  taskResumeContextForDecision,
} from "../runtime/task-resume"
import { emptyDispatchReason, shouldEscalateEmptyDispatch } from "../runtime/empty-dispatch"
import { notifyParentControllerDecision } from "../runtime/notify-controller"
import { needsControllerAttention } from "../runtime/workflow-attention"

type StartOrchestrator = Pick<SessionOrchestrator, "dispatch"> & Partial<Pick<SessionOrchestrator, "resumeNode" | "notifyParent" | "returnToParent">>

export function createStartTool(
  store: ProjectStore,
  orchestrator?: StartOrchestrator,
  progress: ProgressReporter = noopProgressReporter,
): ToolDefinition {
  return tool({
    description: "V5 workflow control. Actions: start_prepared_task, resume_user_input, resume_tasks, resolve_controller_decision. Use resume=\"all\" or resume=[task_id] to recover interrupted tasks after restart.",
    args: {
      run_id: tool.schema.string().optional().describe("Prepared workflow run id."),
      prepared_task_id: tool.schema.string().optional().describe("Alias for run_id."),
      action: tool.schema.enum(["start_prepared_task", "resume_user_input", "resume_tasks", "retry_node", "resolve_controller_decision"]).optional().describe("V5 explicit action."),
      start_action: tool.schema.enum(["start_prepared_task", "resume_user_input", "resume_tasks", "retry_node", "resolve_controller_decision"]).optional().describe("Alias for action."),
      start_config: tool.schema.object({}).passthrough().optional().describe('Optional for start_prepared_task. Omit to use prepared run workflow as built_in_workflow. Example: { "kind": "built_in_workflow", "workflow_id": "feature" }. kind may also be a built-in id like "feature".'),
      confirmation: tool.schema.object({
        user_confirmed: tool.schema.boolean().optional(),
        user_message: tool.schema.string().optional(),
        confirmed_by_session_id: tool.schema.string().optional(),
      }).optional().describe("Required for start_prepared_task."),
      controller_decision: tool.schema.object({}).passthrough().optional().describe("Required for resolve_controller_decision; copy from allowed_controller_decisions."),
      resume_input: tool.schema.object({
        source_node_id: tool.schema.string(),
        answer_text: tool.schema.string().optional(),
        selected_options: tool.schema.array(tool.schema.string()).optional(),
        user_message: tool.schema.string().optional(),
      }).optional().describe("Required for resume_user_input."),
      expected_state_version: tool.schema.string().optional().describe("Optimistic concurrency guard."),
      resume: tool.schema.union([
        tool.schema.literal("all"),
        tool.schema.string(),
        tool.schema.array(tool.schema.string()),
      ]).optional().describe('Recover interrupted tasks: "all", one task_id, or an array of task_id values.'),
      task_id: tool.schema.string().optional().describe("Legacy alias for resume when recovering a single task."),
      session: tool.schema.string().optional().describe("Controller session id."),
      request: tool.schema.string().optional().describe("Legacy field; rejected."),
      workflow: tool.schema.string().optional().describe("Legacy field; rejected."),
      entrypoint: tool.schema.string().optional().describe("Legacy field; rejected."),
      proposal: tool.schema.string().optional().describe("Legacy field; rejected."),
    },
    async execute(args, context) {
      const callerSessionID = args.session ?? context.sessionID
      const runID = args.run_id ?? args.prepared_task_id
      const currentForVersion = runID ? store.readRun(runID) : store.readCurrent()
      const parentSessionID = resolveParentSessionID(currentForVersion, callerSessionID)
      const currentStateVersion = currentForVersion?.state_version ?? (currentForVersion ? `${currentForVersion.updated_at}:legacy` : undefined)
      const requestedAction = normalizeStartAction(args.action ?? args.start_action)
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
      if (requestedAction === "start_prepared_task") {
        validateStartPreparedTaskArgs({
          preparedTaskID: args.prepared_task_id,
          confirmation: args.confirmation,
          startConfig: args.start_config,
        })
      }
      if (!runID && hasLegacyDirectStartPayload(args)) {
        throw new Error("sp_start no longer accepts direct request/workflow/entrypoint/proposal payloads. Call sp_prepare first, ask the user to confirm, then call sp_start(action=\"start_prepared_task\") with prepared_task_id and confirmation (start_config optional).")
      }
      const startAction = currentForVersion ? inferStartAction(currentForVersion, {
        start_action: requestedAction,
        resume_input: args.resume_input,
        task_id: args.task_id,
        resume: args.resume,
      }) : requestedAction ?? "start_prepared_task"
      if (!requestedAction && startAction === "start_prepared_task" && currentForVersion?.activation === "active" && currentForVersion.status === "intake") {
        validateStartPreparedTaskArgs({
          preparedTaskID: args.prepared_task_id,
          confirmation: args.confirmation,
          startConfig: args.start_config,
        })
      }

      const resumeTaskIDs = runID && currentForVersion && hasResumeRequest(args, currentForVersion, requestedAction)
        ? parseResumeTaskIDs(currentForVersion, args.resume, args.task_id)
        : undefined
      if (resumeTaskIDs !== undefined) {
        if (!runID) throw new Error("sp_start resume requires run_id or prepared_task_id.")
        return JSON.stringify(
          await executeTaskResume({
            store,
            orchestrator,
            progress,
            runID,
            parentSessionID,
            state: currentForVersion!,
            taskIDs: resumeTaskIDs,
            startAction: startAction === "resume_tasks" ? startAction : "resume_tasks",
          }),
          null,
          2,
        )
      }

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
          progress,
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
          phase: resumed.node.phase,
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
        if (startAction === "start_prepared_task") {
          const confirmation = normalizeStartConfirmation(args.confirmation)
          store.recordPreparedTaskConfirmation({
            runID,
            parentSessionID,
            userMessage: confirmation.user_message,
            confirmedBySessionID: confirmation.confirmed_by_session_id ?? callerSessionID,
          })
        }
        state = store.activateRun({
          runID,
          parentSessionID,
        })
      } else {
        throw new Error("sp_start requires prepared_task_id and confirmation. Call sp_prepare first, ask the user to confirm, then call sp_start(action=\"start_prepared_task\"). start_config is optional and defaults to the prepared run workflow.")
      }
      const workflowSpec = buildWorkflowSpecFromStartConfig({
        runID: state.id,
        startConfig: args.start_config,
        fallbackWorkflow: state.workflow,
      })
      state = store.setWorkflowSpec({
        runID: state.id,
        parentSessionID,
        workflowSpec,
        workflow: workflowSpec.template_id ?? state.workflow,
        entrypoint: entrypointForWorkflowSpec(workflowSpec, state.entrypoint),
      })
      if (dispatches.length === 0) {
        dispatches = await dispatchStart({
          store,
          orchestrator,
          state,
          taskID: args.task_id,
          startMode,
          progress,
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
  orchestrator?: StartOrchestrator
  state: WorkflowState
  taskID?: string
  startMode: "new" | "resume"
  decisions?: ReturnType<typeof startDecisions>
  resumeFromState?: WorkflowState
  progress?: ProgressReporter
}): Promise<Array<Record<string, string | undefined>>> {
  if (!args.orchestrator) return []
  const decisions = args.decisions ?? startDecisions(args.state, args.startMode, args.taskID)
  if (shouldEscalateEmptyDispatch(args.state, decisions)) {
    const escalated = args.store.markNeedsControllerDecision({
      runID: args.state.id,
      reason: "empty_dispatch",
      detail: emptyDispatchReason(args.state),
    })
    if (args.orchestrator.notifyParent) {
      await notifyParentControllerDecision({
        store: args.store,
        orchestrator: {
          notifyParent: args.orchestrator.notifyParent,
          returnToParent: args.orchestrator.returnToParent,
        },
        progress: args.progress,
        state: escalated,
      })
    }
    return []
  }
  const filtered = args.taskID && args.state.status !== "recovered_unknown" && !args.resumeFromState
    ? decisions.filter((decision) => "task_id" in decision && decision.task_id === args.taskID)
    : decisions
  const resumeState = args.resumeFromState ?? args.state
  const dispatches: Array<Record<string, string | undefined>> = []
  for (const decision of filtered) {
    if (decision.action !== "create_session" && decision.action !== "reuse_session") continue
    const current = args.store.readCurrent() ?? args.state
    const packet = buildNodeTaskPacket({
      state: current,
      decision,
      nodeID: nextDispatchNodeID(current.node_runs.length + dispatches.length + 1, decision.phase, decision.task_id),
      resumeContext: decision.action === "create_session"
        ? taskResumeContextForDecision(resumeState, decision)
        : undefined,
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
        async onPromptDeliveryFailed(input) {
          args.store.markPromptDeliveryFailed({
            session_id: input.sessionID,
            error: input.error,
          })
          const latest = args.store.readCurrent()
          if (latest && needsControllerAttention(latest) && args.orchestrator?.notifyParent) {
            await notifyParentControllerDecision({
              store: args.store,
              orchestrator: {
                notifyParent: args.orchestrator.notifyParent,
                returnToParent: args.orchestrator.returnToParent,
              },
              progress: args.progress,
              state: latest,
            })
          }
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
  progress?: ProgressReporter
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
        progress: args.progress,
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
        progress: args.progress,
        state,
        startMode: "resume",
      })
      return { state: args.store.readCurrent() ?? state, dispatches }
    }
    case "force_dispatch": {
      const state = args.store.resolveControllerDecision({
        runID: args.state.id,
        parentSessionID: args.parentSessionID,
        decision: args.decision,
      })
      const targetID = args.decision.node_id
      if (!targetID) throw new Error("force_dispatch requires node_id.")
      const decision = dispatchDecisionForSpecNodeID(state, targetID)
      if (!decision || (decision.action !== "create_session" && decision.action !== "reuse_session")) {
        throw new Error(`force_dispatch cannot build a session decision for ${targetID}.`)
      }
      const dispatches = await dispatchStart({
        store: args.store,
        orchestrator: args.orchestrator,
        progress: args.progress,
        state,
        startMode: "resume",
        decisions: [decision],
      })
      return { state: args.store.readCurrent() ?? state, dispatches }
    }
    case "skip_node":
    case "cancel_node":
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

function resolveParentSessionID(state: WorkflowState | null | undefined, callerSessionID: string | undefined): string {
  if (!state) return callerSessionID ?? "unknown-session"
  if (!callerSessionID) return state.parent_session_id
  const callerIsChildSession = state.node_runs.some((node) => node.session_id === callerSessionID)
  if (callerIsChildSession) return state.parent_session_id
  return callerSessionID
}

function startDecisions(state: WorkflowState, startMode: "new" | "resume" = "new", _taskID?: string) {
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

async function executeTaskResume(args: {
  store: ProjectStore
  orchestrator?: StartOrchestrator
  progress: ProgressReporter
  runID: string
  parentSessionID: string
  state: WorkflowState
  taskIDs: string[]
  startAction: StartAction
}) {
  if (args.state.status === "canceled" || args.state.status === "passed") {
    throw new Error(`Cannot resume tasks while workflow is ${args.state.status}.`)
  }
  if (args.taskIDs.length === 0) {
    throw new Error("sp_start resume found no incomplete tasks to resume.")
  }
  args.store.activateRun({
    runID: args.runID,
    parentSessionID: args.parentSessionID,
  })
  const resumedState = args.store.markWorkflowResumed({
    runID: args.runID,
    parentSessionID: args.parentSessionID,
    taskIDs: args.taskIDs,
  })
  const decisions = decideTaskResumeDispatches(resumedState, args.taskIDs)
  if (decisions.length === 0) {
    throw new Error(`sp_start resume found no runnable phases for tasks ${args.taskIDs.join(", ")}.`)
  }
  const dispatches = await dispatchStart({
    store: args.store,
    orchestrator: args.orchestrator,
    progress: args.progress,
    state: args.store.readCurrent() ?? resumedState,
    startMode: "resume",
    decisions,
    resumeFromState: args.state,
  })
  await args.progress.report({
    stage: "run_resumed",
    title: "Superpowers workflow",
    message: `${resumedState.workflow} workflow resumed tasks ${args.taskIDs.join(", ")}.`,
    variant: dispatches.length > 0 ? "success" : "info",
  })
  const fresh = args.store.readCurrent() ?? resumedState
  return {
    state: fresh,
    dispatches,
    start_action: args.startAction,
    controller_feedback: buildControllerFeedback(fresh),
  }
}

function hasResumeRequest(
  args: Record<string, unknown>,
  state: WorkflowState,
  requestedAction?: StartAction,
): boolean {
  if (args.resume !== undefined) return true
  if (requestedAction === "resume_tasks") return true
  return state.status === "recovered_unknown"
    && typeof args.task_id === "string"
    && args.task_id.trim().length > 0
    && args.resume_input === undefined
    && args.controller_decision === undefined
}

function isNodeAgentName(agent: string): agent is NodeAgentName {
  return agent in AGENT_SKILL_MAP
}

function normalizeStartAction(action: unknown): StartAction | undefined {
  if (action === undefined) return undefined
  if (action === "approve_design" || action === "approve_plan" || action === "start_entrypoint") {
    throw new Error(
      `sp_start action "${action}" is a legacy public path and is no longer supported. Use v5: sp_prepare -> user confirmation -> sp_start(action="start_prepared_task", prepared_task_id, confirmation, optional start_config), or sp_start(action="resolve_controller_decision") with an allowed controller_decision.`,
    )
  }
  return action as StartAction
}

function hasLegacyDirectStartPayload(args: Record<string, unknown>): boolean {
  return Boolean(args.request || args.workflow || args.entrypoint || args.proposal)
}

type NormalizedStartConfirmation = {
  user_confirmed: boolean
  user_message?: string
  confirmed_by_session_id?: string
}

function validateStartPreparedTaskArgs(args: {
  preparedTaskID: unknown
  confirmation: unknown
  startConfig: unknown
}): void {
  if (typeof args.preparedTaskID !== "string" || !args.preparedTaskID.trim()) {
    throw new Error("sp_start start_prepared_task requires prepared_task_id.")
  }
  const confirmation = normalizeStartConfirmation(args.confirmation)
  if (!confirmation.user_confirmed) {
    throw new Error("sp_start start_prepared_task requires confirmation.user_confirmed true.")
  }
  // start_config is optional; invalid shapes are rejected when building the workflow spec.
  void args.startConfig
}

function normalizeStartConfirmation(value: unknown): NormalizedStartConfirmation {
  if (!value || typeof value !== "object") return { user_confirmed: false }
  const input = value as Record<string, unknown>
  return {
    user_confirmed: input.user_confirmed === true,
    user_message: typeof input.user_message === "string" ? input.user_message : undefined,
    confirmed_by_session_id: typeof input.confirmed_by_session_id === "string" ? input.confirmed_by_session_id : undefined,
  }
}

type StartConfigInput = {
  kind: "built_in_workflow" | "orchestration"
  workflow_id?: string
  auto_expansion?: {
    allow?: boolean
    reason?: string
  }
  orchestration?: WorkflowOrchestration
  required_checks?: Array<"build" | "test" | "lint">
  quality_commands?: Partial<Record<"build" | "test" | "lint", string>>
}

function resolveStartConfig(args: {
  startConfig: unknown
  fallbackWorkflow: WorkflowKind
}): StartConfigInput {
  if (!args.startConfig || typeof args.startConfig !== "object") {
    return {
      kind: "built_in_workflow",
      workflow_id: args.fallbackWorkflow,
    }
  }
  const input = args.startConfig as Record<string, unknown>
  const kind = typeof input.kind === "string" ? input.kind.trim() : ""
  const autoExpansion = normalizeAutoExpansion(input.auto_expansion)
  const requiredChecks = input.required_checks as StartConfigInput["required_checks"] | undefined
  const qualityCommands = input.quality_commands as StartConfigInput["quality_commands"] | undefined
  const workflowID = typeof input.workflow_id === "string" && input.workflow_id.trim()
    ? input.workflow_id.trim()
    : args.fallbackWorkflow

  if (!kind) {
    return {
      kind: "built_in_workflow",
      workflow_id: workflowID,
      auto_expansion: autoExpansion,
      required_checks: requiredChecks,
      quality_commands: qualityCommands,
    }
  }

  if (kind === "built_in_workflow") {
    return {
      kind: "built_in_workflow",
      workflow_id: workflowID,
      auto_expansion: autoExpansion,
      required_checks: requiredChecks,
      quality_commands: qualityCommands,
    }
  }

  if (kind === "orchestration") {
    return {
      kind: "orchestration",
      orchestration: input.orchestration as WorkflowOrchestration | undefined,
      auto_expansion: autoExpansion,
      required_checks: requiredChecks,
      quality_commands: qualityCommands,
    }
  }

  // Compat: controllers often pass kind:"feature" instead of built_in_workflow + workflow_id.
  if (findBuiltInWorkflowTemplate(kind)) {
    return {
      kind: "built_in_workflow",
      workflow_id: kind,
      auto_expansion: autoExpansion,
      required_checks: requiredChecks,
      quality_commands: qualityCommands,
    }
  }

  throw new Error(
    `sp_start start_config.kind must be "built_in_workflow", "orchestration", or a built-in workflow id (feature, bugfix, debug, design-only, plan-only, review, review-only, verify-finish, parallel-investigate, single-agent). Received: "${kind}". Example: { "kind": "built_in_workflow", "workflow_id": "feature" }. Or omit start_config to use the prepared run workflow.`,
  )
}

function normalizeAutoExpansion(value: unknown): StartConfigInput["auto_expansion"] | undefined {
  if (!value || typeof value !== "object") return undefined
  const input = value as Record<string, unknown>
  return {
    allow: typeof input.allow === "boolean" ? input.allow : undefined,
    reason: typeof input.reason === "string" ? input.reason : undefined,
  }
}

function buildWorkflowSpecFromStartConfig(args: {
  runID: string
  startConfig: unknown
  fallbackWorkflow: WorkflowKind
}): WorkflowSpec {
  const config = resolveStartConfig(args)
  if (config.kind === "built_in_workflow") {
    const template = findBuiltInWorkflowTemplate(config.workflow_id)
    if (!template) {
      throw new Error(
        `Unknown built-in workflow template: ${config.workflow_id ?? "(missing workflow_id)"}. Use a known workflow_id or omit start_config to use the prepared run workflow (${args.fallbackWorkflow}).`,
      )
    }
    return createWorkflowSpec({
      id: `${args.runID}-workflow-spec`,
      kind: "built_in_workflow",
      templateID: template.id,
      orchestration: withQualityPolicy(template.orchestration, config),
      autoExpansionAllow: config.auto_expansion?.allow,
      autoExpansionReason: config.auto_expansion?.reason,
    })
  }
  if (!config.orchestration?.nodes?.length) {
    throw new Error(
      'sp_start start_config.kind="orchestration" requires orchestration.nodes. For a built-in template use { "kind": "built_in_workflow", "workflow_id": "feature" }, or omit start_config.',
    )
  }
  return createWorkflowSpec({
    id: `${args.runID}-workflow-spec`,
    kind: "orchestration",
    title: config.orchestration.title,
    orchestration: withQualityPolicy(config.orchestration, config),
    autoExpansionAllow: config.auto_expansion?.allow ?? false,
    autoExpansionReason: config.auto_expansion?.reason ?? "Controller-provided orchestration defaults to bounded unless explicitly allowed.",
  })
}

function withQualityPolicy(orchestration: WorkflowOrchestration, config: StartConfigInput): WorkflowOrchestration {
  return {
    ...orchestration,
    required_checks: config.required_checks ?? orchestration.required_checks,
    quality_commands: config.quality_commands ?? orchestration.quality_commands,
  }
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
