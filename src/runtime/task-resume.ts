import { AGENT_SKILL_MAP, type NodeAgentName } from "../router/modes"
import type { DispatchDecision } from "../router/dispatch-types"
import { incompleteTaskIDs, isTaskLevelPassed } from "../state/task-status"
import type { NodeRun, WorkflowState } from "../state/types"

export type TaskResumeContext = {
  task_id: string
  phase: string
  prior_node_id?: string
  prior_node_status?: NodeRun["status"]
}

export function parseResumeTaskIDs(
  state: WorkflowState,
  resume: unknown,
  legacyTaskID?: string,
): string[] | undefined {
  if (resume === undefined || resume === null) {
    if (!legacyTaskID) return undefined
    return [legacyTaskID]
  }
  if (resume === "all") {
    return incompleteTaskIDs(state)
  }
  if (typeof resume === "string" && resume.trim()) {
    return [resume.trim()]
  }
  if (Array.isArray(resume)) {
    const taskIDs = resume.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    if (taskIDs.length === 0) throw new Error("sp_start resume requires at least one task_id.")
    return taskIDs
  }
  throw new Error('sp_start resume must be "all", a task_id string, or an array of task_id values.')
}

export function decideTaskResumeDispatches(state: WorkflowState, taskIDs: string[]): DispatchDecision[] {
  const unique = [...new Set(taskIDs)]
  const decisions: DispatchDecision[] = []
  for (const taskID of unique) {
    const decision = decideTaskResumeDispatch(state, taskID)
    if (decision) decisions.push(decision)
  }
  return decisions
}

export function decideTaskResumeDispatch(state: WorkflowState, taskID: string): DispatchDecision | null {
  if (isTaskLevelPassed(state, taskID)) return null
  const task = state.task_graph?.tasks.find((candidate) => candidate.id === taskID)
  if (!task) {
    throw new Error(`sp_start resume could not find task_id ${taskID} in task_graph.`)
  }
  if (!taskDependenciesSatisfied(state, task)) {
    return null
  }

  const phases = requiredTaskPhasesForTask(state, task)
  for (const phase of phases) {
    const latest = latestNodeRunForTaskPhase(state, taskID, phase)
    if (latest?.status === "passed") continue
    if (!priorPhasesPassed(state, taskID, phases, phase)) {
      throw new Error(`sp_start resume cannot dispatch ${phase} for ${taskID} because earlier required phases are not passed.`)
    }
    const agent = agentForTaskPhase(task, phase)
    if (!isNodeAgentName(agent)) {
      throw new Error(`sp_start resume cannot dispatch unknown agent ${agent} for ${taskID} ${phase}.`)
    }
    return {
      action: "create_session",
      phase,
      agent,
      primary_skill: AGENT_SKILL_MAP[agent],
      task_id: taskID,
      reason: latest
        ? `resume ${phase} for ${taskID} after ${latest.status} node ${latest.id}`
        : `resume ${phase} for ${taskID}`,
    }
  }

  return null
}

export function taskResumeContextForDecision(
  state: WorkflowState,
  decision: Extract<DispatchDecision, { action: "create_session" }>,
): TaskResumeContext | undefined {
  if (!decision.task_id) return undefined
  const latest = latestNodeRunForTaskPhase(state, decision.task_id, decision.phase)
  return {
    task_id: decision.task_id,
    phase: decision.phase,
    prior_node_id: latest?.id,
    prior_node_status: latest?.status,
  }
}

function priorPhasesPassed(state: WorkflowState, taskID: string, phases: string[], targetPhase: string): boolean {
  for (const phase of phases) {
    if (phase === targetPhase) return true
    const latest = latestNodeRunForTaskPhase(state, taskID, phase)
    if (latest?.status !== "passed") return false
  }
  return true
}

function latestNodeRunForTaskPhase(state: WorkflowState, taskID: string, phase: string): NodeRun | undefined {
  return [...state.node_runs]
    .reverse()
    .find((run) => run.task_id === taskID && run.phase === phase)
}

function requiredTaskPhasesForTask(
  state: WorkflowState,
  task: NonNullable<WorkflowState["task_graph"]>["tasks"][number],
): string[] {
  switch (task.agent) {
    case "sp-planner":
      return ["plan"]
    case "sp-designer":
      return ["design"]
    case "sp-debugger":
      return ["debug"]
    case "sp-investigator":
      return ["investigate"]
    case "sp-acceptance-reviewer":
      return ["acceptance"]
    case "sp-verifier":
      return ["verification"]
    case "sp-code-reviewer":
      return ["code-review"]
    case "sp-finisher":
      return ["finish"]
  }

  switch (state.workflow) {
    case "review":
      return ["acceptance", "verification", "code-review"]
    case "verify-finish":
      return ["verification"]
    case "plan-only":
    case "parallel-investigate":
      return []
    default:
      return ["implement", "acceptance", "verification", "code-review"]
  }
}

function agentForTaskPhase(
  task: NonNullable<WorkflowState["task_graph"]>["tasks"][number],
  phase: string,
): string {
  switch (phase) {
    case "design":
      return "sp-designer"
    case "plan":
      return "sp-planner"
    case "debug":
      return "sp-debugger"
    case "investigate":
      return "sp-investigator"
    case "implement":
      return task.agent ?? "sp-implementer"
    case "acceptance":
      return "sp-acceptance-reviewer"
    case "verification":
      return "sp-verifier"
    case "code-review":
      return "sp-code-reviewer"
    case "finish":
      return "sp-finisher"
    default:
      return task.agent ?? "sp-implementer"
  }
}

function isNodeAgentName(agent: string): agent is NodeAgentName {
  return agent in AGENT_SKILL_MAP
}

function taskDependenciesSatisfied(
  state: WorkflowState,
  task: NonNullable<WorkflowState["task_graph"]>["tasks"][number],
): boolean {
  return task.depends_on.every((dependency) => isTaskLevelPassed(state, dependency))
}
