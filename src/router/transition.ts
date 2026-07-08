import { AGENT_SKILL_MAP, type NodeAgentName } from "./modes"
import { getRunnableTasks, normalizeTaskGraph } from "../state/task-graph"
import { hasRunningNodeRuns, latestNodeRun, taskRunSetsForWorkflow } from "../state/task-status"
import type { SpRecordInput, WorkflowState } from "../state/types"

export type DispatchDecision =
  | {
      action: "create_session"
      phase: string
      agent: NodeAgentName
      primary_skill: string
      task_id?: string
      review_context?: ReviewContext
      reason: string
    }
  | {
      action: "reuse_session"
      phase: string
      agent: NodeAgentName
      primary_skill: string
      session_id: string
      task_id?: string
      review_context?: ReviewContext
      reason: string
    }
  | {
      action: "wait_user"
      reason: string
    }
  | {
      action: "finish"
      reason: string
    }
  | {
      action: "blocked"
      reason: string
    }

export type ReviewContext = {
  source_event: SpRecordInput["event"]
  summary: string
  report?: string
}

export function decideNextDispatches(state: WorkflowState, record?: SpRecordInput): DispatchDecision[] {
  if (!record) return decideFromState(state)
  if (record.status === "progress") return []
  if (record.status === "needs_user") return [{ action: "wait_user", reason: "node requested user input" }]
  if (record.status === "blocked") return [{ action: "blocked", reason: record.summary }]
  if (record.status === "failed") return failedRecordDispatches(state, record)
  if (state.activation === "draft" && record.event === "design") {
    return [{ action: "wait_user", reason: "candidate design is ready for approval or revision" }]
  }
  if (state.activation === "draft" && record.event === "plan") {
    if (!record.task_graph?.tasks.length && state.workflow !== "plan-only") {
      return [{ action: "blocked", reason: "candidate plan passed without a task graph" }]
    }
    return [{ action: "wait_user", reason: "candidate plan is ready for approval or revision" }]
  }

  switch (record.event) {
    case "intake":
      return dispatchEntrypoint(state)
    case "design":
      return [create("plan", "sp-planner", "design passed")]
    case "debug":
      return [create("implement", "sp-implementer", "root cause recorded")]
    case "investigation":
      if (state.node_runs.some((run) => run.agent === "sp-investigator" && run.status === "running")) return []
      return [create("finish", "sp-finisher", "investigation passed")]
    case "plan":
      if (state.workflow === "plan-only") {
        return [{ action: "finish", reason: "plan-only workflow complete" }]
      }
      return planDispatches(state, record)
    case "implementation":
      return [
        create("acceptance", "sp-acceptance-reviewer", "implementation passed", latestTaskID(state, "implement"), {
          source_event: record.event,
          summary: record.summary,
          report: record.artifacts?.patch_summary,
        }),
      ]
    case "acceptance":
      return [create("verification", "sp-verifier", "acceptance passed", latestTaskID(state, "acceptance"))]
    case "verification":
      return [create("code-review", "sp-code-reviewer", "verification passed", latestTaskID(state, "verification"))]
    case "code-review":
      if (state.task_graph?.tasks.length) {
        const runnable = planDispatches(state, record)
        if (runnable.length > 0) return runnable
        if (!allGraphTasksCodeReviewed(state) || hasRunningNodeRuns(state)) return []
      }
      return [create("finish", "sp-finisher", "code review passed")]
    case "finish":
      return [{ action: "finish", reason: "finish record passed" }]
    default:
      return []
  }
}

function decideFromState(state: WorkflowState): DispatchDecision[] {
  if (state.status === "waiting_user") return [{ action: "wait_user", reason: "workflow is waiting for user input" }]
  if (state.status === "awaiting_design_approval") return [{ action: "wait_user", reason: "candidate design is waiting for approval or revision" }]
  if (state.status === "awaiting_plan_approval") return [{ action: "wait_user", reason: "candidate plan is waiting for approval or revision" }]
  if (state.status === "canceled") return [{ action: "blocked", reason: "workflow is canceled" }]
  if (state.status === "recovered_unknown") {
    const interrupted = state.node_runs.filter((run) => run.status === "interrupted").map((run) => run.id)
    const suffix = interrupted.length > 0 ? ` Interrupted nodes: ${interrupted.join(", ")}.` : ""
    return [{
      action: "blocked",
      reason: `workflow was recovered after startup and needs user confirmation before retry or cancel.${suffix}`,
    }]
  }

  const finish = latestNodeRun(state, (run) => run.phase === "finish")
  if (finish?.status === "running") return []
  if (finish?.status === "passed") return [{ action: "finish", reason: "finish record passed" }]
  if (finish?.status === "needs_user") return [{ action: "wait_user", reason: "finish node requested user input" }]
  if (finish && ["failed", "blocked", "canceled"].includes(finish.status)) return [create("finish", "sp-finisher", `finish is ${finish.status}; retry finish`)]

  const blockedCheck = latestRecoverableCheck(state)
  if (blockedCheck) return failedRecordDispatches(state, {
    event: eventForPhase(blockedCheck.phase),
    status: "failed",
    summary: `${blockedCheck.phase} is ${blockedCheck.status}; retry implementation`,
  })

  if (state.status === "waiting_user_decision") return [{ action: "blocked", reason: "workflow is waiting for a controller/user decision" }]
  if (state.status === "blocked" || state.status === "failed") return [{ action: "blocked", reason: `workflow is ${state.status}` }]
  if (hasRunningNodeRuns(state)) return []

  if (state.task_graph?.tasks.length) {
    const runnable = planDispatches(state, {
      event: "plan",
      status: "passed",
      summary: "Recover runnable tasks from durable state.",
    })
    if (runnable.length > 0) return runnable
    if (allGraphTasksCodeReviewed(state)) return [create("finish", "sp-finisher", "all task graph checks passed")]
    return []
  }

  switch (state.current_phase) {
    case "design-complete":
      return [create("plan", "sp-planner", "design already passed")]
    case "root-cause-found":
      return [create("implement", "sp-implementer", "root cause already recorded")]
    case "investigation-complete":
    case "code-review-passed":
    case "verification-passed":
      return [create("finish", "sp-finisher", `${state.current_phase} is ready for finish`)]
    case "intake":
    case "plan":
      if (state.node_runs.length === 0) return dispatchEntrypoint(state)
      return []
    default:
      return []
  }
}

function dispatchEntrypoint(state: WorkflowState): DispatchDecision[] {
  const specDecision = dispatchFromWorkflowSpec(state)
  if (specDecision.length > 0) return specDecision

  if (state.workflow === "feature" && state.entrypoint === "execute") {
    return [create("implement", "sp-implementer", "execute entrypoint confirmed")]
  }

  switch (state.workflow) {
    case "bugfix":
    case "debug":
      return [create("debug", "sp-debugger", "debug workflow confirmed")]
    case "design-only":
      return [create("design", "sp-designer", "design-only workflow confirmed")]
    case "plan-only":
      return [create("plan", "sp-planner", "plan workflow confirmed")]
    case "review-only":
      return [create("code-review", "sp-code-reviewer", "review-only workflow confirmed")]
    case "review":
      return [create("acceptance", "sp-acceptance-reviewer", "review workflow confirmed")]
    case "verify-finish":
      return [create("verification", "sp-verifier", "verify-finish workflow confirmed")]
    case "parallel-investigate":
      return [create("investigate", "sp-investigator", "parallel investigation confirmed")]
    case "single-agent":
      return [create("implement", "sp-implementer", "single-agent workflow confirmed")]
    default:
      return [create("design", "sp-designer", "feature workflow confirmed")]
  }
}

function planDispatches(state: WorkflowState, record: SpRecordInput): DispatchDecision[] {
  const graph = state.task_graph
  if (!graph) return [{ action: "blocked", reason: "plan passed without task graph" }]
  const normalized = normalizeTaskGraph(graph)
  const { passed, running, failed } = taskRunSetsForWorkflow({ ...state, task_graph: normalized })
  return getRunnableTasks(normalized, { passed, running, failed }).map((task) => {
    const agent = isNodeAgentName(task.agent) ? task.agent : "sp-implementer"
    return create(phaseForAgent(agent), agent, `task ${task.id} is runnable`, task.id)
  })
}

function failedRecordDispatches(state: WorkflowState, record: SpRecordInput): DispatchDecision[] {
  if (!["acceptance", "code-review", "verification"].includes(record.event)) {
    return [{ action: "blocked", reason: record.summary }]
  }

  const failedTaskID = latestTaskID(state, phaseForEvent(record.event))
  const lastImplementer = [...state.node_runs]
    .reverse()
    .find((run) => run.agent === "sp-implementer" && (!failedTaskID || run.task_id === failedTaskID))
  if (lastImplementer) {
    return [
      {
        action: "reuse_session",
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: AGENT_SKILL_MAP["sp-implementer"],
        session_id: lastImplementer.session_id,
        task_id: lastImplementer.task_id,
        review_context: {
          source_event: record.event,
          summary: record.summary,
          report: record.findings ?? record.checks ?? record.artifacts?.acceptance ?? record.artifacts?.code_review ?? record.artifacts?.verification_log,
        },
        reason: `${record.event} failed; retry implementation`,
      },
    ]
  }
  return [create("implement", "sp-implementer", `${record.event} failed; create retry implementer`)]
}

function create(phase: string, agent: NodeAgentName, reason: string, taskID?: string, reviewContext?: ReviewContext): DispatchDecision {
  return {
    action: "create_session",
    phase,
    agent,
    primary_skill: AGENT_SKILL_MAP[agent],
    task_id: taskID,
    review_context: reviewContext,
    reason,
  }
}

function dispatchFromWorkflowSpec(state: WorkflowState): DispatchDecision[] {
  const node = state.workflow_spec?.orchestration.nodes[0]
  if (!node || !isNodeAgentName(node.agent)) return []
  return [create(node.phase ?? phaseForAgent(node.agent), node.agent, `workflow spec entry node ${node.id}`, node.task_id)]
}

function isNodeAgentName(agent: string | undefined): agent is NodeAgentName {
  return agent !== undefined && agent in AGENT_SKILL_MAP
}

function phaseForAgent(agent: NodeAgentName): string {
  switch (agent) {
    case "sp-designer":
      return "design"
    case "sp-planner":
      return "plan"
    case "sp-debugger":
      return "debug"
    case "sp-investigator":
      return "investigate"
    case "sp-acceptance-reviewer":
      return "acceptance"
    case "sp-code-reviewer":
      return "code-review"
    case "sp-verifier":
      return "verification"
    case "sp-finisher":
      return "finish"
    default:
      return "implement"
  }
}

function latestTaskID(state: WorkflowState, phase: string): string | undefined {
  const runs = [...state.node_runs].reverse()
  return (
    runs.find((run) => run.phase === phase && run.task_id && run.status !== "running")?.task_id ??
    runs.find((run) => run.phase === phase && run.task_id)?.task_id
  )
}

function phaseForEvent(event: SpRecordInput["event"]): string {
  switch (event) {
    case "implementation":
      return "implement"
    case "code-review":
      return "code-review"
    default:
      return event
  }
}

function allGraphTasksCodeReviewed(state: WorkflowState): boolean {
  if (!state.task_graph?.tasks.length) return true
  return state.task_graph.tasks.every((task) => taskRunSetsForWorkflow(state).passed.has(task.id))
}

function latestRecoverableCheck(state: WorkflowState) {
  return latestNodeRun(
    state,
    (run) => ["acceptance", "verification", "code-review"].includes(run.phase) && ["failed", "blocked", "needs_user"].includes(run.status),
  )
}

function eventForPhase(phase: string): SpRecordInput["event"] {
  if (phase === "code-review") return "code-review"
  if (phase === "verification") return "verification"
  return "acceptance"
}
