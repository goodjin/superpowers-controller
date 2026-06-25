import { AGENT_SKILL_MAP, type NodeAgentName } from "./modes"
import { getRunnableTasks, normalizeTaskGraph } from "../state/task-graph"
import type { SpRecordInput, WorkflowState } from "../state/types"

export type DispatchDecision =
  | {
      action: "create_session"
      phase: string
      agent: NodeAgentName
      primary_skill: string
      task_id?: string
      reason: string
    }
  | {
      action: "reuse_session"
      phase: string
      agent: NodeAgentName
      primary_skill: string
      session_id: string
      task_id?: string
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

export function decideNextDispatches(state: WorkflowState, record?: SpRecordInput): DispatchDecision[] {
  if (!record) return decideFromState(state)
  if (record.status === "needs_user") return [{ action: "wait_user", reason: "node requested user input" }]
  if (record.status === "blocked") return [{ action: "blocked", reason: record.summary }]
  if (record.status === "failed") return failedRecordDispatches(state, record)
  if (state.activation === "draft" && record.event === "plan") {
    return [{ action: "wait_user", reason: "plan is ready for controller review and user confirmation" }]
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
      if (state.node_runs.some((run) => run.agent === "sp-implementer" && run.status === "running")) return []
      return [create("acceptance", "sp-acceptance-reviewer", "implementation passed")]
    case "acceptance":
      return [create("verification", "sp-verifier", "acceptance passed")]
    case "verification":
      return [create("code-review", "sp-code-reviewer", "verification passed")]
    case "code-review":
      return [create("finish", "sp-finisher", "code review passed")]
    case "finish":
      return [{ action: "finish", reason: "finish record passed" }]
    default:
      return []
  }
}

function decideFromState(state: WorkflowState): DispatchDecision[] {
  if (state.status === "waiting_user") return [{ action: "wait_user", reason: "workflow is waiting for user input" }]
  if (state.status === "blocked") return [{ action: "blocked", reason: "workflow is blocked" }]
  return []
}

function dispatchEntrypoint(state: WorkflowState): DispatchDecision[] {
  switch (state.workflow) {
    case "debug":
      return [create("debug", "sp-debugger", "debug workflow confirmed")]
    case "plan-only":
      return [create("plan", "sp-planner", "plan workflow confirmed")]
    case "review":
      return [create("acceptance", "sp-acceptance-reviewer", "review workflow confirmed")]
    case "verify-finish":
      return [create("verification", "sp-verifier", "verify-finish workflow confirmed")]
    case "parallel-investigate":
      return [create("investigate", "sp-investigator", "parallel investigation confirmed")]
    default:
      return [create("design", "sp-designer", "feature workflow confirmed")]
  }
}

function planDispatches(state: WorkflowState, record: SpRecordInput): DispatchDecision[] {
  const graph = record.task_graph ?? state.task_graph
  if (!graph) return [create("implement", "sp-implementer", "plan passed without task graph")]
  const normalized = normalizeTaskGraph(graph)
  const passed = new Set(state.node_runs.filter((run) => run.task_id && run.status === "passed").map((run) => run.task_id as string))
  const running = new Set(state.node_runs.filter((run) => run.task_id && run.status === "running").map((run) => run.task_id as string))
  const failed = new Set(state.node_runs.filter((run) => run.task_id && run.status === "failed").map((run) => run.task_id as string))
  return getRunnableTasks(normalized, { passed, running, failed }).map((task) =>
    create("implement", "sp-implementer", `task ${task.id} is runnable`, task.id),
  )
}

function failedRecordDispatches(state: WorkflowState, record: SpRecordInput): DispatchDecision[] {
  if (!["acceptance", "code-review", "verification"].includes(record.event)) {
    return [{ action: "blocked", reason: record.summary }]
  }

  const lastImplementer = [...state.node_runs].reverse().find((run) => run.agent === "sp-implementer")
  if (lastImplementer) {
    return [
      {
        action: "reuse_session",
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: AGENT_SKILL_MAP["sp-implementer"],
        session_id: lastImplementer.session_id,
        task_id: lastImplementer.task_id,
        reason: `${record.event} failed; retry implementation`,
      },
    ]
  }
  return [create("implement", "sp-implementer", `${record.event} failed; create retry implementer`)]
}

function create(phase: string, agent: NodeAgentName, reason: string, taskID?: string): DispatchDecision {
  return {
    action: "create_session",
    phase,
    agent,
    primary_skill: AGENT_SKILL_MAP[agent],
    task_id: taskID,
    reason,
  }
}
