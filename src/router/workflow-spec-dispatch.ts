import { findBuiltInWorkflowTemplate, createWorkflowSpec } from "../capabilities/workflows"
import { AGENT_SKILL_MAP, type NodeAgentName } from "./modes"
import { hasRunningNodeRuns, latestNodeRun } from "../state/task-status"
import type { DispatchDecision, ReviewContext } from "./dispatch-types"
import type { NodeRun, SpRecordInput, WorkflowNodeSpec, WorkflowOrchestration, WorkflowSpec, WorkflowState } from "../state/types"

const CHECK_RETRY_PHASES = new Set(["acceptance", "verification", "code-review"])

export function ensureWorkflowSpec(state: WorkflowState): WorkflowSpec {
  if (state.workflow_spec) {
    if (state.task_graph?.tasks.length) {
      return {
        ...state.workflow_spec,
        orchestration: mergeTaskGraphIntoOrchestration(state.workflow_spec.orchestration, state, false),
      }
    }
    return state.workflow_spec
  }
  const template = findBuiltInWorkflowTemplate(state.workflow)
  if (!template) {
    return createWorkflowSpec({
      id: `${state.id}-workflow-spec`,
      kind: "orchestration",
      title: state.workflow,
      orchestration: { nodes: [], edges: [] },
    })
  }
  const orchestration = mergeTaskGraphIntoOrchestration(template.orchestration, state, false)
  return createWorkflowSpec({
    id: `${state.id}-workflow-spec`,
    kind: "built_in_workflow",
    templateID: template.id,
    orchestration,
    autoExpansionAllow: template.default_start_config.auto_expansion.allow,
    autoExpansionReason: template.default_start_config.auto_expansion.reason,
  })
}

type TransitionContext = {
  passed_node_ids: Set<string>
}

export function decideFromWorkflowSpec(state: WorkflowState, record?: SpRecordInput): DispatchDecision[] {
  const spec = ensureWorkflowSpec(state)
  const orchestration = spec.orchestration

  if (record?.status === "progress") return []
  if (record?.status === "needs_user") return [{ action: "wait_user", reason: "node requested user input" }]
  if (record?.status === "blocked") return [{ action: "blocked", reason: record.summary }]

  if (state.activation === "draft" && record?.event === "design" && record.status === "passed") {
    return [{ action: "wait_user", reason: "candidate design is ready for approval or revision" }]
  }
  if (state.activation === "draft" && record?.event === "plan" && record.status === "passed") {
    if (!record.task_graph?.tasks.length && state.workflow !== "plan-only") {
      return [{ action: "blocked", reason: "candidate plan passed without a task graph" }]
    }
    return [{ action: "wait_user", reason: "candidate plan is ready for approval or revision" }]
  }

  if (record?.status === "failed") {
    return failedDispatchesFromSpec(state, record, spec)
  }

  if (record?.event === "intake" && record.status === "passed") {
    if (state.workflow === "feature" && state.entrypoint === "execute") {
      const implement = spec.orchestration.nodes.find((node) => node.agent === "sp-implementer" && !shouldSkipSupersededTemplateNode(state, node))
      if (implement) {
        const decision = decisionForSpecNode(state, implement, record, undefined)
        return decision ? [decision] : []
      }
    }
    const entryNodes = findRunnableSpecNodes(state, spec.orchestration.nodes)
      .filter((node) => (node.depends_on ?? []).length === 0)
    if (entryNodes.length > 0) {
      return entryNodes.map((node) => decisionForSpecNode(state, node, record, undefined)!).filter(Boolean)
    }
    return [{ action: "blocked", reason: "workflow-spec has no runnable entry node after intake" }]
  }

  if (record) {
    const sourceNode = resolveReportingSpecNode(state, record, orchestration.nodes)
    if (!sourceNode) {
      return [{ action: "blocked", reason: `no workflow-spec node matches report event ${record.event}` }]
    }
    const transition: TransitionContext = {
      passed_node_ids: record.status === "passed" ? new Set([sourceNode.id]) : new Set(),
    }
    if (record.event === "plan" && record.status === "passed" && state.task_graph?.tasks.length) {
      const taskTargets = orchestration.nodes
        .filter((node) => node.agent === "sp-implementer" && node.task_id)
        .filter((node) => isSpecNodeRunnable(state, node, transition))
      if (taskTargets.length > 0) {
        const sourceRun = latestRunForSpecNode(state, sourceNode)
        return taskTargets
          .map((node) => decisionForSpecNode(state, node, record, sourceNode, sourceRun)!)
          .filter(Boolean)
      }
    }
    const targets = resolveTransitionTargets(orchestration, sourceNode.id, record)
      .filter((node) => isSpecNodeRunnable(state, node, transition))
    const sourceRun = latestRunForSpecNode(state, sourceNode)
    const decisions = targets
      .map((node) => decisionForSpecNode(state, node, record, sourceNode, sourceRun))
      .filter((decision): decision is DispatchDecision => decision !== undefined)
    if (decisions.length > 0) return decisions
    if (record.status === "passed" && isWorkflowComplete(state, spec)) {
      return [{ action: "finish", reason: workflowFinishReason(state, spec) }]
    }
    if (record.event === "plan" && state.workflow === "plan-only" && record.status === "passed") {
      return [{ action: "finish", reason: "plan-only workflow complete" }]
    }
    return []
  }

  return decideRunnableFromSpec(state, spec)
}

function decideRunnableFromSpec(state: WorkflowState, spec: WorkflowSpec): DispatchDecision[] {
  if (state.status === "waiting_user") return [{ action: "wait_user", reason: "workflow is waiting for user input" }]
  if (state.status === "awaiting_design_approval") {
    return [{ action: "wait_user", reason: "candidate design is waiting for approval or revision" }]
  }
  if (state.status === "awaiting_plan_approval") {
    return [{ action: "wait_user", reason: "candidate plan is waiting for approval or revision" }]
  }
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
  if (finish && ["failed", "blocked", "canceled"].includes(finish.status)) {
    const node = spec.orchestration.nodes.find((item) => item.agent === "sp-finisher")
    if (node) return [decisionForSpecNode(state, node, undefined, undefined)!]
    return [{ action: "blocked", reason: `finish is ${finish.status}; no finisher node in workflow-spec` }]
  }

  const blockedCheck = latestNodeRun(
    state,
    (run) => CHECK_RETRY_PHASES.has(run.phase) && ["failed", "blocked", "needs_user"].includes(run.status),
  )
  if (blockedCheck) {
    return failedDispatchesFromSpec(state, {
      event: eventForPhase(blockedCheck.phase),
      status: "failed",
      summary: `${blockedCheck.phase} is ${blockedCheck.status}; retry implementation`,
    }, spec)
  }

  if (state.status === "waiting_user_decision" || state.status === "waiting_controller_decision") {
    return [{ action: "blocked", reason: "workflow is waiting for a controller decision" }]
  }
  if (state.status === "blocked" || state.status === "failed") {
    if (hasRunningNodeRuns(state)) return []
    return [{ action: "blocked", reason: `workflow is ${state.status}` }]
  }
  if (hasRunningNodeRuns(state)) return []

  const runnable = findRunnableSpecNodes(state, spec.orchestration.nodes)
  if (runnable.length > 0) {
    return runnable.map((node) => decisionForSpecNode(state, node, undefined, undefined)!).filter(Boolean)
  }

  if (isWorkflowComplete(state, spec)) {
    const finisher = spec.orchestration.nodes.find((node) => node.agent === "sp-finisher" && !isSpecNodeTerminal(state, node))
    if (finisher) return [decisionForSpecNode(state, finisher, undefined, undefined)!]
    return [{ action: "finish", reason: workflowFinishReason(state, spec) }]
  }

  return []
}

function failedDispatchesFromSpec(state: WorkflowState, record: SpRecordInput, spec: WorkflowSpec): DispatchDecision[] {
  const sourceNode = resolveReportingSpecNode(state, record, spec.orchestration.nodes)
  if (sourceNode) {
    const targets = resolveTransitionTargets(spec.orchestration, sourceNode.id, record)
    const retryTargets = targets.filter((node) => node.agent === "sp-implementer")
    if (retryTargets.length > 0) {
      return retryTargets.map((node) => retryImplementerDecision(state, record, node)).filter(Boolean) as DispatchDecision[]
    }
  }

  if (CHECK_RETRY_PHASES.has(phaseForRecordEvent(record.event))) {
    const taskID = latestTaskID(state, phaseForRecordEvent(record.event))
    const lastImplementer = [...state.node_runs]
      .reverse()
      .find((run) => run.agent === "sp-implementer" && (!taskID || run.task_id === taskID))
    if (lastImplementer && isNodeAgentName(lastImplementer.agent)) {
      return [{
        action: "reuse_session",
        phase: "implement",
        agent: lastImplementer.agent,
        primary_skill: AGENT_SKILL_MAP[lastImplementer.agent],
        session_id: lastImplementer.session_id,
        task_id: lastImplementer.task_id,
        review_context: reviewContextFromRecord(record),
        reason: `${record.event} failed; retry implementation`,
      }]
    }
    if (isNodeAgentName("sp-implementer")) {
      return [{
        action: "create_session",
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: AGENT_SKILL_MAP["sp-implementer"],
        task_id: taskID,
        review_context: reviewContextFromRecord(record),
        reason: `${record.event} failed; create retry implementer`,
      }]
    }
  }

  return [{ action: "blocked", reason: record.summary }]
}

function resolveTransitionTargets(
  orchestration: WorkflowOrchestration,
  sourceNodeID: string,
  record: SpRecordInput,
): WorkflowNodeSpec[] {
  const nodesByID = new Map(orchestration.nodes.map((node) => [node.id, node]))
  const edgeTargets = (orchestration.edges ?? [])
    .filter((edge) => edge.from === sourceNodeID && matchesEdgeCondition(edge.condition, record))
    .map((edge) => nodesByID.get(edge.to))
    .filter((node): node is WorkflowNodeSpec => node !== undefined)

  if (edgeTargets.length > 0) return uniqueNodes(edgeTargets)

  if (record.status !== "passed") return []

  return orchestration.nodes.filter((node) => node.depends_on?.includes(sourceNodeID))
}

function findRunnableSpecNodes(
  state: WorkflowState,
  nodes: WorkflowNodeSpec[],
  transition: TransitionContext = { passed_node_ids: new Set() },
): WorkflowNodeSpec[] {
  return nodes.filter((node) => isSpecNodeRunnable(state, node, transition))
}

function isSpecNodeRunnable(
  state: WorkflowState,
  node: WorkflowNodeSpec,
  transition: TransitionContext = { passed_node_ids: new Set() },
): boolean {
  if (!isNodeAgentName(node.agent)) return false
  if (shouldSkipStaleTemplateEntryNode(state, node)) return false
  if (shouldSkipSupersededTemplateNode(state, node)) return false
  if (isSpecNodeTerminal(state, node)) return false
  if (hasActiveRunForSpecNode(state, node)) return false
  return (node.depends_on ?? []).every((dependency) => isDependencySatisfied(state, dependency, node, transition))
}

function isDependencySatisfied(
  state: WorkflowState,
  dependencyID: string,
  _dependentNode: WorkflowNodeSpec,
  transition: TransitionContext = { passed_node_ids: new Set() },
): boolean {
  const dependencyNode = findNodeByID(state, dependencyID)
  if (!dependencyNode) return false
  if (transition.passed_node_ids.has(dependencyID)) {
    const phase = dependencyNode.phase ?? phaseForAgent(dependencyNode.agent)
    // Check-chain reports only unlock dependents when prior check nodes already passed.
    // Implement/design/plan reports unlock their direct downstream without re-proving earlier template stages.
    if (!CHECK_RETRY_PHASES.has(phase)) return true
    const emptyTransition: TransitionContext = { passed_node_ids: new Set() }
    return (dependencyNode.depends_on ?? []).every((prerequisite) =>
      isDependencySatisfied(state, prerequisite, dependencyNode, emptyTransition),
    )
  }
  return isSpecNodePassed(state, dependencyNode)
}

function shouldSkipStaleTemplateEntryNode(state: WorkflowState, node: WorkflowNodeSpec): boolean {
  if (!/^\d{2}-/.test(node.id) || node.task_id) return false
  if (state.task_graph?.tasks.length && (node.agent === "sp-designer" || node.agent === "sp-planner")) return true
  if (node.agent !== "sp-designer" && node.agent !== "sp-planner") return false
  const hasTaskRuns = state.node_runs.some((run) => run.task_id)
  if (hasTaskRuns) return true
  if (state.task_graph?.tasks.length && node.agent === "sp-designer") {
    return state.node_runs.some((run) => run.phase === "plan" && run.status === "passed")
  }
  return false
}

function shouldSkipSupersededTemplateNode(state: WorkflowState, node: WorkflowNodeSpec): boolean {
  if (!state.task_graph?.tasks.length) return false
  if (node.task_id) return false
  if (!/^\d{2}-/.test(node.id)) return false
  const supersededPhases = new Set(["implement", "acceptance", "verification", "code-review"])
  const phase = node.phase ?? phaseForAgent(node.agent)
  if (!supersededPhases.has(phase)) return false
  return state.task_graph.tasks.some((task) => {
    const taskAgent = task.agent ?? "sp-implementer"
    if (phase === "implement") return taskAgent === "sp-implementer"
    return taskAgent === "sp-implementer"
  })
}

function isSpecNodeTerminal(state: WorkflowState, node: WorkflowNodeSpec): boolean {
  const run = latestRunForSpecNode(state, node)
  return run?.status === "passed"
}

function isSpecNodePassed(state: WorkflowState, node: WorkflowNodeSpec): boolean {
  const run = latestRunForSpecNode(state, node)
  return run?.status === "passed"
}

function hasActiveRunForSpecNode(state: WorkflowState, node: WorkflowNodeSpec): boolean {
  return state.node_runs.some((run) => run.status === "running" && matchesSpecNode(run, node))
}

function latestRunForSpecNode(state: WorkflowState, node: WorkflowNodeSpec): NodeRun | undefined {
  return [...state.node_runs].reverse().find((run) => matchesSpecNode(run, node))
}

function matchesSpecNode(run: NodeRun, node: WorkflowNodeSpec): boolean {
  if (run.id === node.id) return true
  if (node.task_id && run.task_id === node.task_id) {
    const nodePhase = node.phase ?? phaseForAgent(node.agent)
    return run.phase === nodePhase && run.agent === node.agent
  }
  const nodePhase = node.phase ?? phaseForAgent(node.agent)
  if (!node.task_id && run.phase === nodePhase && run.agent === node.agent) return true
  return false
}

function resolveReportingSpecNode(
  state: WorkflowState,
  record: SpRecordInput,
  nodes: WorkflowNodeSpec[],
): WorkflowNodeSpec | undefined {
  const eventPhase = phaseForRecordEvent(record.event)
  const taskScopedEvents = new Set<SpRecordInput["event"]>(["implementation", "acceptance", "verification", "code-review"])
  if (state.task_graph?.tasks.length && taskScopedEvents.has(record.event)) {
    const taskID = latestTaskID(state, eventPhase)
      ?? [...state.node_runs].reverse().find((run) => run.status === "passed" && run.task_id)?.task_id
    if (taskID) {
      const taskNode = nodes.find((node) => node.task_id === taskID && (node.phase ?? phaseForAgent(node.agent)) === eventPhase)
      if (taskNode) return taskNode
      return undefined
    }
  }

  const completedRun = [...state.node_runs]
    .reverse()
    .find((run) => run.phase === eventPhase && run.status !== "running")
  if (completedRun) {
    const matched = nodes.find((node) => matchesSpecNode(completedRun, node))
    if (matched) return matched
  }

  const running = [...state.node_runs].reverse().find((run) => run.phase === eventPhase && run.status === "running")
  if (running) {
    const matched = nodes.find((node) => matchesSpecNode(running, node))
    if (matched) return matched
  }

  return nodes.find((node) => (node.phase ?? phaseForAgent(node.agent)) === eventPhase)
}

function decisionForSpecNode(
  state: WorkflowState,
  node: WorkflowNodeSpec,
  record: SpRecordInput | undefined,
  sourceNode: WorkflowNodeSpec | undefined,
  sourceRun?: NodeRun,
): DispatchDecision | undefined {
  if (!isNodeAgentName(node.agent)) return undefined
  const phase = node.phase ?? phaseForAgent(node.agent)
  const taskID = node.task_id ?? sourceRun?.task_id
  const reviewContext = record && sourceNode && record.event === "implementation" && record.status === "passed"
    ? {
        source_event: record.event,
        summary: record.summary,
        report: record.artifacts?.patch_summary,
      }
    : undefined

  if (record?.status === "failed" && node.agent === "sp-implementer") {
    return retryImplementerDecision(state, record, node)
  }

  return {
    action: "create_session",
    phase,
    agent: node.agent,
    primary_skill: AGENT_SKILL_MAP[node.agent],
    task_id: taskID,
    review_context: reviewContext,
    reason: record
      ? `${sourceNode?.id ?? "workflow-spec"} ${record.status}; dispatch ${node.id}`
      : `workflow-spec node ${node.id} is runnable`,
  }
}

function retryImplementerDecision(
  state: WorkflowState,
  record: SpRecordInput,
  node: WorkflowNodeSpec,
): DispatchDecision | undefined {
  if (!isNodeAgentName(node.agent)) return undefined
  const taskID = node.task_id ?? latestTaskID(state, phaseForRecordEvent(record.event))
  const lastImplementer = [...state.node_runs]
    .reverse()
    .find((run) => run.agent === "sp-implementer" && (!taskID || run.task_id === taskID))
  if (lastImplementer && isNodeAgentName(lastImplementer.agent)) {
    return {
      action: "reuse_session",
      phase: "implement",
      agent: lastImplementer.agent,
      primary_skill: AGENT_SKILL_MAP[lastImplementer.agent],
      session_id: lastImplementer.session_id,
      task_id: lastImplementer.task_id,
      review_context: reviewContextFromRecord(record),
      reason: `${record.event} failed; retry implementation`,
    }
  }
  return {
    action: "create_session",
    phase: "implement",
    agent: "sp-implementer",
    primary_skill: AGENT_SKILL_MAP["sp-implementer"],
    task_id: taskID,
    review_context: reviewContextFromRecord(record),
    reason: `${record.event} failed; create retry implementer`,
  }
}

function isWorkflowComplete(state: WorkflowState, spec: WorkflowSpec): boolean {
  if (hasRunningNodeRuns(state)) return false
  const finisher = spec.orchestration.nodes.find((node) => node.agent === "sp-finisher")
  if (finisher) return isSpecNodePassed(state, finisher)
  const leafNodes = spec.orchestration.nodes.filter((node) => {
    if (shouldSkipStaleTemplateEntryNode(state, node) || shouldSkipSupersededTemplateNode(state, node)) return false
    const hasOutgoing = (spec.orchestration.edges ?? []).some((edge) => edge.from === node.id)
    const hasDependents = spec.orchestration.nodes.some((other) => other.depends_on?.includes(node.id))
    return !hasOutgoing && !hasDependents
  })
  if (leafNodes.length === 0) return false
  return leafNodes.every((node) => isSpecNodeTerminal(state, node))
}

function workflowFinishReason(state: WorkflowState, spec: WorkflowSpec): string {
  if (state.workflow === "plan-only") return "plan-only workflow complete"
  const finisher = spec.orchestration.nodes.find((node) => node.agent === "sp-finisher")
  if (finisher && isSpecNodePassed(state, finisher)) return "finish record passed"
  return "workflow-spec completion policy satisfied"
}

function mergeTaskGraphIntoOrchestration(
  orchestration: WorkflowOrchestration,
  state: WorkflowState,
  includePlanDependency = false,
): WorkflowOrchestration {
  if (!state.task_graph?.tasks.length) return orchestration
  const planNodeID = includePlanDependency
    ? orchestration.nodes.find((node) => node.agent === "sp-planner")?.id
    : undefined
  const taskNodes = buildTaskGraphSpecNodes(state.task_graph.tasks, planNodeID)
  let nodes = mergeSpecNodes(orchestration.nodes, taskNodes)
  const terminalIDs = state.task_graph.tasks.map((task) => terminalWorkflowNodeIDForTask(task))
  const finish = nodes.find((node) => node.agent === "sp-finisher" && !node.task_id)
  const edges = [
    ...(orchestration.edges ?? []),
    ...(buildTaskGraphSpecEdges(taskNodes, planNodeID) ?? []),
  ]
  if (finish && terminalIDs.length > 0) {
    nodes = nodes.map((node) =>
      node.id === finish.id
        ? { ...node, depends_on: terminalIDs }
        : node,
    )
    for (const terminalID of terminalIDs) {
      edges.push({ from: terminalID, to: finish.id, condition: "passed" })
    }
  }
  return { ...orchestration, nodes, edges }
}

export function buildTaskGraphSpecNodes(
  tasks: NonNullable<WorkflowState["task_graph"]>["tasks"],
  planNodeID?: string,
): WorkflowNodeSpec[] {
  const tasksByID = new Map(tasks.map((task) => [task.id, task]))
  const nodes: WorkflowNodeSpec[] = []
  for (const task of tasks) {
    const implementID = workflowNodeIDForTask(task.id)
    const agent = task.agent ?? "sp-implementer"
    const dependsOn = [
      ...task.depends_on.map((dependencyID) => {
        const dependency = tasksByID.get(dependencyID)
        return dependency ? terminalWorkflowNodeIDForTask(dependency) : workflowNodeIDForTask(dependencyID)
      }),
      ...(planNodeID ? [planNodeID] : []),
    ]
    nodes.push({
      id: implementID,
      title: task.title,
      agent,
      phase: phaseForAgent(agent),
      task_id: task.id,
      depends_on: dependsOn,
      report_contract: ["sp_report"],
    })
    if (agent === "sp-implementer") {
      nodes.push(
        {
          id: `${implementID}-acceptance`,
          agent: "sp-acceptance-reviewer",
          phase: "acceptance",
          task_id: task.id,
          depends_on: [implementID],
          report_contract: ["sp_report"],
        },
        {
          id: `${implementID}-verification`,
          agent: "sp-verifier",
          phase: "verification",
          task_id: task.id,
          depends_on: [`${implementID}-acceptance`],
          report_contract: ["sp_report"],
        },
        {
          id: `${implementID}-code-review`,
          agent: "sp-code-reviewer",
          phase: "code-review",
          task_id: task.id,
          depends_on: [`${implementID}-verification`],
          report_contract: ["sp_report"],
        },
      )
    }
  }
  return nodes
}

export function buildTaskGraphSpecEdges(taskNodes: WorkflowNodeSpec[], planNodeID?: string): WorkflowOrchestration["edges"] {
  const edges: NonNullable<WorkflowOrchestration["edges"]> = []
  for (const node of taskNodes) {
    for (const dependency of node.depends_on ?? []) {
      edges.push({ from: dependency, to: node.id, condition: "passed" })
    }
    if (node.phase === "implement" || (node.agent === "sp-implementer" && node.id.startsWith("task-"))) {
      edges.push(
        { from: node.id, to: `${node.id}-acceptance`, condition: "passed" },
        { from: `${node.id}-acceptance`, to: `${node.id}-verification`, condition: "passed" },
        { from: `${node.id}-verification`, to: `${node.id}-code-review`, condition: "passed" },
        { from: `${node.id}-acceptance`, to: node.id, condition: "failed" },
        { from: `${node.id}-verification`, to: node.id, condition: "failed" },
        { from: `${node.id}-code-review`, to: node.id, condition: "failed" },
      )
    }
  }
  if (planNodeID) {
    for (const node of taskNodes) {
      if (node.agent === "sp-implementer" || node.agent === "sp-planner") {
        edges.push({ from: planNodeID, to: node.id, condition: "passed" })
      }
    }
  }
  return edges
}

function matchesEdgeCondition(condition: string | undefined, record: SpRecordInput): boolean {
  if (!condition) return record.status === "passed"
  const normalized = condition.trim().toLowerCase()
  if (normalized === "passed") return record.status === "passed"
  if (normalized === "failed") return record.status === "failed"
  if (normalized === "blocked") return record.status === "blocked"
  if (normalized === "needs_user") return record.status === "needs_user"
  if (normalized.startsWith("on_status:")) {
    return record.status === normalized.slice("on_status:".length)
  }
  if (normalized.startsWith("on_event:")) {
    const [, event, status] = normalized.split(":")
    return record.event === event && record.status === status
  }
  return false
}

function findNodeByID(state: WorkflowState, nodeID: string): WorkflowNodeSpec | undefined {
  const spec = ensureWorkflowSpec(state)
  return spec.orchestration.nodes.find((node) => node.id === nodeID)
}

function uniqueNodes(nodes: WorkflowNodeSpec[]): WorkflowNodeSpec[] {
  const seen = new Set<string>()
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false
    seen.add(node.id)
    return true
  })
}

function mergeSpecNodes(existing: WorkflowNodeSpec[], incoming: WorkflowNodeSpec[]): WorkflowNodeSpec[] {
  const byID = new Map(existing.map((node) => [node.id, node]))
  for (const node of incoming) byID.set(node.id, node)
  return [...byID.values()]
}

function workflowNodeIDForTask(taskID: string): string {
  return `task-${taskID}`
}

export function terminalWorkflowNodeIDForTask(task: {
  id: string
  agent?: string
}): string {
  const base = workflowNodeIDForTask(task.id)
  const agent = task.agent ?? "sp-implementer"
  if (agent === "sp-implementer") return `${base}-code-review`
  return base
}

function phaseForAgent(agent: string): string {
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

function phaseForRecordEvent(event: SpRecordInput["event"]): string {
  if (event === "implementation") return "implement"
  if (event === "investigation") return "investigate"
  if (event === "code-review") return "code-review"
  if (event === "red-test") return "red-test"
  return event
}

function eventForPhase(phase: string): SpRecordInput["event"] {
  if (phase === "implement") return "implementation"
  if (phase === "code-review") return "code-review"
  if (phase === "verification") return "verification"
  if (phase === "acceptance") return "acceptance"
  return phase as SpRecordInput["event"]
}

function latestTaskID(state: WorkflowState, phase: string): string | undefined {
  const runs = [...state.node_runs].reverse()
  return (
    runs.find((run) => run.phase === phase && run.task_id && run.status !== "running")?.task_id ??
    runs.find((run) => run.phase === phase && run.task_id)?.task_id
  )
}

function reviewContextFromRecord(record: SpRecordInput): ReviewContext {
  return {
    source_event: record.event,
    summary: record.summary,
    report: record.findings ?? record.checks ?? record.artifacts?.acceptance ?? record.artifacts?.code_review ?? record.artifacts?.verification_log,
  }
}

function isNodeAgentName(agent: string): agent is NodeAgentName {
  return agent in AGENT_SKILL_MAP
}
