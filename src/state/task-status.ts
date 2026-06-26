import type { NodeRun, WorkflowState } from "./types"
import type { TaskRunSets } from "./task-graph"

const BLOCKING_STATUSES = new Set<NodeRun["status"]>(["running", "failed", "blocked", "needs_user", "interrupted"])

export function taskRunSetsForWorkflow(state: WorkflowState): TaskRunSets {
  const passed = new Set<string>()
  const running = new Set<string>()
  const failed = new Set<string>()

  for (const task of state.task_graph?.tasks ?? []) {
    if (isTaskLevelPassed(state, task.id)) {
      passed.add(task.id)
      continue
    }

    const latest = latestNodeRunsByPhase(state, task.id)
    const statuses = Array.from(latest.values()).map((run) => run.status)
    if (statuses.includes("running")) running.add(task.id)
    if (statuses.some((status) => status === "failed" || status === "blocked" || status === "needs_user" || status === "interrupted")) {
      failed.add(task.id)
    }
    if (statuses.length > 0 && !running.has(task.id) && !failed.has(task.id)) running.add(task.id)
  }

  return { passed, running, failed }
}

export function incompleteTaskIDs(state: WorkflowState): string[] {
  if (!state.task_graph?.tasks.length) return []
  return state.task_graph.tasks.map((task) => task.id).filter((taskID) => !isTaskLevelPassed(state, taskID))
}

export function isTaskLevelPassed(state: WorkflowState, taskID: string): boolean {
  const latest = latestNodeRunsByPhase(state, taskID)
  if (latest.size === 0) return false
  if (Array.from(latest.values()).some((run) => BLOCKING_STATUSES.has(run.status))) return false
  return requiredTaskPhases(state).every((phase) => latest.get(phase)?.status === "passed")
}

export function hasRunningNodeRuns(state: WorkflowState): boolean {
  return state.node_runs.some((run) => run.status === "running")
}

export function latestNodeRun(state: WorkflowState, predicate: (run: NodeRun) => boolean): NodeRun | undefined {
  return [...state.node_runs].reverse().find(predicate)
}

function latestNodeRunsByPhase(state: WorkflowState, taskID: string): Map<string, NodeRun> {
  const latest = new Map<string, NodeRun>()
  for (const run of [...state.node_runs].reverse()) {
    if (run.task_id !== taskID) continue
    if (!latest.has(run.phase)) latest.set(run.phase, run)
  }
  return latest
}

function requiredTaskPhases(state: WorkflowState): string[] {
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
