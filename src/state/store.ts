import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { applyRecord, createInitialState } from "./transitions"
import { normalizeTaskGraph } from "./task-graph"
import { buildTaskGraphSpecEdges, buildTaskGraphSpecNodes } from "../router/workflow-spec-dispatch"
import { createWorkflowSpec, findBuiltInWorkflowTemplate } from "../capabilities/workflows"
import { resolveWorkflowStatusAfterNodeReport, sessionErrorNodeStatus, workflowStatusAfterNodeFailure } from "../runtime/workflow-attention"
import { mergeQualityChecksFromRecord } from "../runtime/quality-checks"
import { formatSilentExitMarkdown } from "../runtime/silent-exit"
import { projectStateRoot } from "./paths"
import type {
  ControllerDecision,
  NodeRun,
  PrepareMode,
  ResumeInput,
  WorkflowArtifact,
  WorkflowEntrypoint,
  WorkflowDocumentSpec,
  WorkflowExpansionPatch,
  WorkflowKind,
  WorkflowMode,
  WorkflowNodeSpec,
  WorkflowRecord,
  WorkflowSpec,
  WorkflowState,
} from "./types"

export type ProjectStore = {
  root: string
  readCurrent(): WorkflowState | null
  readRun(runID: string): WorkflowState | null
  listRuns(): WorkflowState[]
  /** Outcome of the most recent recordNodeResult call in this process. */
  lastRecordOutcome(): { lateIgnored: boolean } | null
  start(args: { session: string; mode: WorkflowMode; goal: string }): WorkflowState
  startRun(args: {
    workflow: WorkflowKind
    entrypoint: WorkflowEntrypoint
    goal: string
    request: string
    proposal: string
    parentSessionID: string
  }): WorkflowState
  prepareRun(args: {
    workflow: WorkflowKind
    entrypoint: WorkflowEntrypoint
    goal: string
    request: string
    proposal: string
    parentSessionID: string
    sourceWorkflowID?: string
    prepareMode?: PrepareMode
  }): WorkflowState
  activateRun(args: {
    runID: string
    parentSessionID: string
  }): WorkflowState
  markWorkflowResumed(args: {
    runID: string
    parentSessionID: string
    taskIDs: string[]
  }): WorkflowState
  recordPreparedTaskConfirmation(args: {
    runID: string
    parentSessionID: string
    userMessage?: string
    confirmedBySessionID?: string
  }): WorkflowState
  approveDesign(args: {
    runID: string
    parentSessionID: string
    approvedBySessionID: string
  }): WorkflowState
  approvePlan(args: {
    runID: string
    parentSessionID: string
    approvedBySessionID: string
  }): WorkflowState
  markDispatchFailed(args: {
    phase: string
    agent: string
    primary_skill?: string
    task_id?: string
    session_id?: string
    task_markdown?: string
    error: unknown
  }): NodeRun
  markPromptDeliveryFailed(args: {
    session_id: string
    error: unknown
  }): NodeRun | null
  markSessionError(args: {
    session_id: string
    error: unknown
  }): NodeRun | null
  markNotificationFailed(args: {
    node_id: string
    error: unknown
  }): NodeRun | null
  markLivenessExpired(args: {
    session_id: string
    idle_ms: number
  }): NodeRun | null
  markUnreportedExit(args: {
    session_id: string
    reason: "session_idle" | "liveness_timeout" | "session_error"
    summary: string
    node_status?: Extract<NodeRun["status"], "interrupted" | "failed">
    evidence: {
      assistant_text: string
      produced_paths: string[]
      collected_at: string
      error?: string
      idle_ms?: number
    }
  }): { node: NodeRun; artifact_path: string } | null
  recordAuditEvent(args: {
    event: string
    summary: string
  }): WorkflowState | null
  recoverInterruptedRunningNodes(args: { reason: string }): WorkflowState | null
  healInterruptedBusySessions(args: {
    sessionIDs: string[]
    reason?: string
  }): WorkflowState | null
  consumePendingQuestion(args: {
    runID: string
    parentSessionID?: string
    resumeInput: ResumeInput
  }): { state: WorkflowState; node: NodeRun }
  resolveControllerDecision(args: {
    runID: string
    parentSessionID?: string
    decision: ControllerDecision
  }): WorkflowState
  setWorkflowSpec(args: {
    runID: string
    parentSessionID?: string
    workflowSpec: WorkflowSpec
    workflow?: WorkflowKind
    entrypoint?: WorkflowEntrypoint
  }): WorkflowState
  record(record: WorkflowRecord): WorkflowState
  recordNodeResult(args: { nodeID?: string; sessionID?: string; agent?: string; input: WorkflowRecord }): WorkflowState
  cancel(args: { runID?: string; taskID?: string; sessionID?: string; reason?: string }): WorkflowState
  addNodeRun(args: {
    phase: string
    agent: string
    primary_skill?: string
    session_id: string
    task_id?: string
    task_markdown: string
  }): NodeRun
  reset(): void
}

export type ProjectStoreOptions = {
  reconcileOnLoad?: boolean
}

/** Read only current.json + the active run state, without scanning every historical run directory. */
export function readCurrentWorkflowState(project: string): WorkflowState | null {
  const root = projectStateRoot(project)
  const currentPath = join(root, "current.json")
  if (!existsSync(currentPath)) return null
  try {
    const pointer = JSON.parse(readFileSync(currentPath, "utf8")) as { run?: string }
    if (!pointer.run) return null
    return readStateFromDisk(root, pointer.run)
  } catch {
    return null
  }
}

export function createProjectStore(project: string, options: ProjectStoreOptions = {}): ProjectStore {
  const root = projectStateRoot(project)
  let loaded = false
  let currentRunID: string | undefined
  const runtimeRuns = new Map<string, WorkflowState>()
  let lastRecordOutcome: { lateIgnored: boolean } | null = null

  function loadRuntimeMemory(): void {
    if (loaded) return
    loaded = true
    const currentPath = join(root, "current.json")
    if (existsSync(currentPath)) {
      const pointer = JSON.parse(readFileSync(currentPath, "utf8")) as { run?: string }
      currentRunID = pointer.run
    }
    const runsRoot = join(root, "runs")
    if (!existsSync(runsRoot)) return
    for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const state = readStateFromDisk(root, entry.name)
      if (state) runtimeRuns.set(state.id, state)
    }
    if (options.reconcileOnLoad && currentRunID) {
      const current = runtimeRuns.get(currentRunID)
      if (current) {
        const reconciled = reconcileStartupState(current, {
          reason: "Store loaded persisted state; previous running workflow state cannot be assumed live after startup.",
        })
      if (reconciled.changed) {
          const withFallback = addStartupFallbackSummaries(root, reconciled.state, reconciled, reconciled.reason)
          runtimeRuns.set(withFallback.id, withFallback)
          writeState(root, withFallback)
          appendStartupRecoveryEvidence(root, withFallback, reconciled, reconciled.reason)
        }
      }
    }
  }

  function persistCurrent(state: WorkflowState): WorkflowState {
    loaded = true
    runtimeRuns.set(state.id, state)
    currentRunID = state.id
    writeState(root, state)
    writeCurrent(root, state.id)
    return state
  }

  function persistRun(state: WorkflowState): WorkflowState {
    loaded = true
    runtimeRuns.set(state.id, state)
    writeState(root, state)
    return state
  }

  return {
    root,
    lastRecordOutcome() {
      return lastRecordOutcome
    },
    readCurrent() {
      loadRuntimeMemory()
      return currentRunID ? runtimeRuns.get(currentRunID) ?? null : null
    },
    readRun(runID) {
      loadRuntimeMemory()
      return runtimeRuns.get(runID) ?? null
    },
    listRuns() {
      loadRuntimeMemory()
      return [...runtimeRuns.values()]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    },
    start(args) {
      const state = createInitialState({
        id: randomUUID(),
        project,
        session: args.session,
        mode: args.mode,
        goal: args.goal,
      })
      persistCurrent(state)
      writeRunMarkdown(root, state.id, "request.md", `# Request\n\n${args.goal.trim()}\n`)
      writeDocumentsManifest(root, state)
      appendChangelog(root, state.id, `created ${args.mode} workflow`)
      return state
    },
    startRun(args) {
      const state = createWorkflowState({
        id: randomUUID(),
        project,
        workflow: args.workflow,
        entrypoint: args.entrypoint,
        goal: args.goal,
        parentSessionID: args.parentSessionID,
        activation: "active",
      })
      initializeRunRoot(runRootFor(root, state.id))
      persistCurrent(state)
      writeRunMarkdown(root, state.id, "request.md", args.request)
      writeRunMarkdown(root, state.id, "task.md", args.request)
      writeRunMarkdown(root, state.id, "proposal.md", args.proposal)
      writeDocumentsManifest(root, state)
      appendEvent(root, state.id, { type: "workflow_started", workflow: state.workflow, entrypoint: state.entrypoint })
      appendChangelog(root, state.id, `created ${args.workflow} workflow from ${args.entrypoint}`)
      return state
    },
    prepareRun(args) {
      let state = createWorkflowState({
        id: randomUUID(),
        project,
        workflow: args.workflow,
        entrypoint: args.entrypoint,
        goal: args.goal,
        parentSessionID: args.parentSessionID,
        activation: "draft",
        prepareMode: args.prepareMode,
      })
      initializeRunRoot(runRootFor(root, state.id))
      if (args.sourceWorkflowID) {
        const source = this.readRun(args.sourceWorkflowID)
        if (!source) throw new Error(`No Superpowers workflow found for source ${args.sourceWorkflowID}.`)
        state = {
          ...state,
          task_graph: source.task_graph ? normalizeTaskGraph(source.task_graph) : undefined,
          artifacts: copySourceArtifacts(root, source.id, state.id, source.artifacts),
        }
      }
      persistCurrent(state)
      writeRunMarkdown(root, state.id, "request.md", args.request)
      writeRunMarkdown(root, state.id, "task.md", args.request)
      writeRunMarkdown(root, state.id, "proposal.md", args.proposal)
      writeDocumentsManifest(root, state)
      appendEvent(root, state.id, { type: "workflow_prepared", workflow: state.workflow, entrypoint: state.entrypoint })
      appendChangelog(root, state.id, `prepared ${args.workflow} workflow from ${args.entrypoint}`)
      return state
    },
    activateRun(args) {
      const current = this.readRun(args.runID)
      if (!current) {
        throw new Error(`No Superpowers workflow found for run ${args.runID}.`)
      }
      const wasDraft = current.activation === "draft"
      const parent = parentSessionFields(current, args.parentSessionID, new Date().toISOString())
      const next: WorkflowState = {
        ...current,
        activation: "active",
        session: parent.session,
        parent_session_id: parent.parent_session_id,
        phase: wasDraft && current.phase === "awaiting-plan-approval" ? "plan-complete" : current.phase,
        current_phase: wasDraft && current.current_phase === "awaiting-plan-approval" ? "plan-complete" : current.current_phase,
        status: wasDraft && current.status === "waiting_user" ? "running" : current.status,
        pending_question: wasDraft ? undefined : current.pending_question,
        updated_at: new Date().toISOString(),
        state_version: nextStateVersion(),
        history: parent.history,
      }
      persistCurrent(next)
      appendChangelog(root, next.id, `activated ${next.workflow} workflow from ${next.entrypoint}`)
      return next
    },
    markWorkflowResumed(args) {
      const current = this.readRun(args.runID)
      if (!current) {
        throw new Error(`No Superpowers workflow found for run ${args.runID}.`)
      }
      const now = new Date().toISOString()
      const parent = parentSessionFields(current, args.parentSessionID, now)
      const next: WorkflowState = {
        ...current,
        session: parent.session,
        parent_session_id: parent.parent_session_id,
        status: current.status === "recovered_unknown" || current.status === "blocked" ? "running" : current.status,
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...parent.history,
          {
            at: now,
            event: "controller_resume_tasks",
            from: current.phase,
            to: current.phase,
            summary: `Controller resumed tasks ${args.taskIDs.join(", ")} after workflow recovery.`,
          },
        ],
      }
      persistCurrent(next)
      appendEvent(root, next.id, {
        type: "controller_resume_tasks",
        task_ids: args.taskIDs,
        state_version: next.state_version,
      })
      appendChangelog(root, next.id, `controller resumed tasks ${args.taskIDs.join(", ")}`)
      return next
    },
    recordPreparedTaskConfirmation(args) {
      const current = this.readRun(args.runID)
      if (!current) {
        throw new Error(`No Superpowers workflow found for run ${args.runID}.`)
      }
      const now = new Date().toISOString()
      const parent = parentSessionFields(current, args.parentSessionID, now)
      const next: WorkflowState = {
        ...current,
        session: parent.session,
        parent_session_id: parent.parent_session_id,
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...parent.history,
          {
            at: now,
            event: "prepared_task_confirmed",
            from: current.phase,
            to: current.phase,
            summary: args.userMessage ?? "User confirmed prepared task start.",
          },
        ],
      }
      persistCurrent(next)
      appendEvent(root, next.id, {
        type: "prepared_task_confirmed",
        user_message: args.userMessage,
        confirmed_by_session_id: args.confirmedBySessionID,
        parent_session_id: args.parentSessionID,
        state_version: next.state_version,
      })
      appendChangelog(root, next.id, `confirmed prepared task${args.userMessage ? `: ${args.userMessage}` : ""}`)
      return next
    },
    approveDesign(args) {
      const current = this.readRun(args.runID)
      if (!current) throw new Error(`No Superpowers workflow found for run ${args.runID}.`)
      if (current.status !== "awaiting_design_approval") {
        throw new Error(`sp_start approve_design requires awaiting_design_approval; current status is ${current.status}.`)
      }
      const candidate = latestCandidateRecord(root, current.id, "design")
      if (!candidate.record.artifacts?.spec) {
        throw new Error("sp_start approve_design requires the latest passed design report to include artifacts.spec.")
      }
      const now = new Date().toISOString()
      const parent = parentSessionFields(current, args.parentSessionID, now)
      writeArtifacts(root, current.id, { spec: candidate.record.artifacts.spec })
      const next: WorkflowState = {
        ...current,
        session: parent.session,
        parent_session_id: parent.parent_session_id,
        status: "running",
        phase: "design-approved",
        current_phase: "design-approved",
        gates: { ...current.gates, design_approved: true, spec_written: true },
        artifacts: { ...current.artifacts, spec: "spec.md" },
        pending_question: undefined,
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...parent.history,
          {
            at: now,
            event: "design_approved",
            from: current.phase,
            to: "design-approved",
            summary: `Approved design from ${candidate.nodeID}.`,
          },
        ],
      }
      persistCurrent(next)
      appendEvent(root, next.id, {
        type: "design_approved",
        source_node_id: candidate.nodeID,
        approved_by_session_id: args.approvedBySessionID,
        approved_at: now,
        state_version: next.state_version,
      })
      appendChangelog(root, next.id, `approved design from ${candidate.nodeID}`)
      return next
    },
    approvePlan(args) {
      const current = this.readRun(args.runID)
      if (!current) throw new Error(`No Superpowers workflow found for run ${args.runID}.`)
      if (current.status !== "awaiting_plan_approval") {
        throw new Error(`sp_start approve_plan requires awaiting_plan_approval; current status is ${current.status}.`)
      }
      const candidate = latestCandidateRecord(root, current.id, "plan")
      if (!candidate.record.artifacts?.plan) {
        throw new Error("sp_start approve_plan requires the latest passed plan report to include artifacts.plan.")
      }
      if (!candidate.record.task_graph?.tasks.length && current.workflow !== "plan-only") {
        throw new Error("sp_start approve_plan requires a candidate task_graph before implementation.")
      }
      const graph = candidate.record.task_graph ? normalizeTaskGraph(candidate.record.task_graph) : undefined
      const now = new Date().toISOString()
      const parent = parentSessionFields(current, args.parentSessionID, now)
      writeArtifacts(root, current.id, { plan: candidate.record.artifacts.plan })
      if (graph) {
        writeJson(root, current.id, "task_graph.json", graph)
        writeJson(root, current.id, "tasks.json", graph)
      }
      const next: WorkflowState = {
        ...current,
        activation: "active",
        session: parent.session,
        parent_session_id: parent.parent_session_id,
        status: current.workflow === "plan-only" ? "passed" : "running",
        phase: "plan-complete",
        current_phase: "plan-complete",
        gates: { ...current.gates, plan_written: true },
        artifacts: { ...current.artifacts, plan: "plan.md" },
        task_graph: graph ?? current.task_graph,
        pending_question: undefined,
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...parent.history,
          {
            at: now,
            event: "plan_approved",
            from: current.phase,
            to: "plan-complete",
            summary: `Approved plan from ${candidate.nodeID}.`,
          },
        ],
      }
      persistCurrent(next)
      appendEvent(root, next.id, {
        type: "plan_approved",
        source_node_id: candidate.nodeID,
        approved_by_session_id: args.approvedBySessionID,
        approved_at: now,
        state_version: next.state_version,
      })
      appendChangelog(root, next.id, `approved plan from ${candidate.nodeID}`)
      return next
    },
    recoverInterruptedRunningNodes(args) {
      const current = this.readCurrent()
      if (!current) return null
      const reconciled = reconcileStartupState(current, args)
      if (!reconciled.changed) return current
      const withFallback = addStartupFallbackSummaries(root, reconciled.state, reconciled, args.reason)
      persistCurrent(withFallback)
      appendStartupRecoveryEvidence(root, withFallback, reconciled, args.reason)
      return withFallback
    },
    healInterruptedBusySessions(args) {
      const current = this.readCurrent()
      if (!current) return null
      const live = new Set(args.sessionIDs.filter((id) => typeof id === "string" && id.length > 0))
      if (live.size === 0) return null
      const now = new Date().toISOString()
      const healedIDs: string[] = []
      const nodeRuns = current.node_runs.map((node) => {
        if (node.status !== "interrupted" || !live.has(node.session_id)) return node
        healedIDs.push(node.id)
        return {
          ...node,
          status: "running" as const,
          closed_at: undefined,
          ended_at: undefined,
          reported_at: undefined,
        }
      })
      if (healedIDs.length === 0) return null
      const reason = args.reason ?? "TUI observed host session still busy; restored interrupted node to running."
      const next: WorkflowState = {
        ...current,
        status: resumableStatus(current.status),
        node_runs: nodeRuns,
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...current.history,
          {
            at: now,
            event: "tui_healed_interrupted_busy_sessions",
            from: current.phase,
            to: current.phase,
            summary: `${reason} Nodes: ${healedIDs.join(", ")}.`,
          },
        ],
      }
      persistCurrent(next)
      appendEvent(root, next.id, {
        type: "tui_healed_interrupted_busy_sessions",
        node_ids: healedIDs,
        session_ids: [...live],
        reason,
      })
      appendChangelog(root, next.id, `tui healed interrupted busy nodes ${healedIDs.join(", ")}: ${reason}`)
      return next
    },
    consumePendingQuestion(args) {
      const current = this.readRun(args.runID)
      if (!current) {
        throw new Error(`No Superpowers workflow found for run ${args.runID}.`)
      }
      if (current.status !== "waiting_user" || !current.pending_question) {
        throw new Error(`Superpowers workflow ${args.runID} is not waiting for user input.`)
      }
      const expectedNodeID = current.pending_question.source_node_id
      if (!expectedNodeID) {
        throw new Error(`Superpowers workflow ${args.runID} has a pending question without a source node.`)
      }
      if (args.resumeInput.source_node_id !== expectedNodeID) {
        throw new Error(`resume_input source_node_id ${args.resumeInput.source_node_id} does not match the pending question ${expectedNodeID}.`)
      }
      const sourceNode = current.node_runs.find((node) => node.id === expectedNodeID)
      if (!sourceNode) {
        throw new Error(`No node run found for pending question source ${expectedNodeID}.`)
      }
      const now = new Date().toISOString()
      const parentSessionID = args.parentSessionID ?? current.parent_session_id
      const parent = parentSessionFields(current, parentSessionID, now)
      const resumedNode: NodeRun = {
        ...sourceNode,
        status: "running",
        closed_at: undefined,
        ended_at: undefined,
      }
      const next: WorkflowState = {
        ...current,
        session: parent.session,
        parent_session_id: parent.parent_session_id,
        status: "running",
        phase: sourceNode.phase,
        current_phase: sourceNode.phase,
        pending_question: undefined,
        node_runs: current.node_runs.map((node) => node.id === sourceNode.id ? resumedNode : node),
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...parent.history,
          {
            at: now,
            event: "user_input_resumed",
            from: "waiting-user",
            to: sourceNode.phase,
            summary: `Resumed ${sourceNode.id} with user input.`,
          },
        ],
      }
      persistCurrent(next)
      appendEvent(root, next.id, {
        type: "user_input_resumed",
        node_id: sourceNode.id,
        session_id: sourceNode.session_id,
        task_id: sourceNode.task_id,
      })
      appendChangelog(root, next.id, `resumed ${sourceNode.id} with user input`)
      return { state: next, node: resumedNode }
    },
    resolveControllerDecision(args) {
      const current = this.readRun(args.runID)
      if (!current) {
        throw new Error(`No Superpowers workflow found for run ${args.runID}.`)
      }
      if (args.decision.kind === "apply_workflow_patch" && (args.decision.workflow_patch || current.pending_workflow_expansion)) {
        const now = new Date().toISOString()
        const parentSessionID = args.parentSessionID ?? current.parent_session_id
        const parent = parentSessionFields(current, parentSessionID, now)
        const base: WorkflowState = {
          ...current,
          session: parent.session,
          parent_session_id: parent.parent_session_id,
          history: parent.history,
          status: "running",
        }
        const patched = applyWorkflowExpansionToState(root, base, args.decision.workflow_patch ?? current.pending_workflow_expansion as WorkflowExpansionPatch)
        persistCurrent(patched)
        appendEvent(root, patched.id, {
          type: "controller_decision_apply_workflow_patch",
          decision: args.decision,
          state_version: patched.state_version,
        })
        appendChangelog(root, patched.id, `controller applied workflow patch: ${args.decision.reason ?? "no reason provided"}`)
        return patched
      }
      if (args.decision.kind === "replace_orchestration" && args.decision.orchestration && current.workflow_spec) {
        const now = new Date().toISOString()
        const parentSessionID = args.parentSessionID ?? current.parent_session_id
        const parent = parentSessionFields(current, parentSessionID, now)
        const next: WorkflowState = {
          ...current,
          session: parent.session,
          parent_session_id: parent.parent_session_id,
          status: "running",
          phase: "workflow-orchestration-replaced",
          current_phase: "workflow-orchestration-replaced",
          workflow_spec: {
            ...current.workflow_spec,
            updated_at: now,
            orchestration: args.decision.orchestration,
          },
          updated_at: now,
          state_version: nextStateVersion(),
          history: [
            ...parent.history,
            {
              at: now,
              event: "controller_decision_replace_orchestration",
              from: current.phase,
              to: "workflow-orchestration-replaced",
              summary: args.decision.reason ?? "Controller replaced workflow orchestration.",
            },
          ],
        }
        persistCurrent(next)
        appendEvent(root, next.id, {
          type: "controller_decision_replace_orchestration",
          decision: args.decision,
          state_version: next.state_version,
        })
        appendChangelog(root, next.id, `controller replaced orchestration: ${args.decision.reason ?? "no reason provided"}`)
        return next
      }
      const now = new Date().toISOString()
      const parentSessionID = args.parentSessionID ?? current.parent_session_id
      const parent = parentSessionFields(current, parentSessionID, now)
      const status = statusForControllerDecision(current, args.decision)
      const phase = phaseForControllerDecision(current, args.decision)
      const summary = args.decision.reason ?? `Controller resolved workflow with ${args.decision.kind}.`
      const next: WorkflowState = {
        ...current,
        session: parent.session,
        parent_session_id: parent.parent_session_id,
        status,
        phase,
        current_phase: phase,
        pending_question: undefined,
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...parent.history,
          {
            at: now,
            event: `controller_decision_${args.decision.kind}`,
            from: current.phase,
            to: phase,
            summary,
          },
        ],
        next: nextForControllerDecision(args.decision),
      }
      persistCurrent(next)
      appendEvent(root, next.id, {
        type: `controller_decision_${args.decision.kind}`,
        decision: args.decision,
        status,
        phase,
        state_version: next.state_version,
      })
      appendChangelog(root, next.id, `controller decision ${args.decision.kind}: ${summary}`)
      return next
    },
    setWorkflowSpec(args) {
      const current = this.readRun(args.runID)
      if (!current) {
        throw new Error(`No Superpowers workflow found for run ${args.runID}.`)
      }
      const next: WorkflowState = {
        ...current,
        ...parentSessionFields(current, args.parentSessionID ?? current.parent_session_id, new Date().toISOString()),
        workflow: args.workflow ?? current.workflow,
        entrypoint: args.entrypoint ?? current.entrypoint,
        workflow_spec: args.workflowSpec,
        updated_at: new Date().toISOString(),
        state_version: nextStateVersion(),
      }
      writeJson(root, next.id, "workflow-spec.json", args.workflowSpec)
      persistCurrent(next)
      appendEvent(root, next.id, {
        type: "workflow_spec_set",
        workflow_spec_id: args.workflowSpec.id,
        template_id: args.workflowSpec.template_id,
        auto_expansion: args.workflowSpec.auto_expansion,
      })
      appendChangelog(root, next.id, `set workflow spec ${args.workflowSpec.id}`)
      return next
    },
    record(record) {
      const current = this.readCurrent()
      if (!current) {
        throw new Error("No active Superpowers workflow. Call sp_status or sp_prepare first.")
      }
      if (!isDraftCandidateRecord(current, record)) writeArtifacts(root, current.id, record.artifacts ?? {})
      const nodeIndex = current.history.filter((entry) => entry.event !== "created").length + 1
      writeNodeRecord(root, current.id, nodeIndex, record)
      if (record.task_graph && !isDraftCandidateRecord(current, record)) {
        const normalized = normalizeTaskGraph(record.task_graph)
        writeJson(root, current.id, "task_graph.json", normalized)
      }
      const next = applyRecord(current, record)
      persistCurrent(next)
      appendChangelog(root, next.id, `${record.event}: ${record.status} - ${record.summary}`)
      return next
    },
    recordNodeResult(args) {
      const current = this.readCurrent()
      if (!current) {
        throw new Error("No active Superpowers workflow. Call sp_start first.")
      }
      const staleSessionNode = args.sessionID
        ? current.node_runs.find((run) => run.session_id === args.sessionID && run.status !== "running")
        : undefined
      if (staleSessionNode && !args.nodeID) {
        const ignoredNodeID = `${staleSessionNode.id}-late-${Date.now()}`
        writeNodeRecordByID(root, current.id, ignoredNodeID, args.input)
        appendEvent(root, current.id, {
          type: "late_report_ignored",
          source_node_id: staleSessionNode.id,
          session_id: args.sessionID,
          event: args.input.event,
          status: args.input.status,
          summary: args.input.summary,
        })
        appendChangelog(root, current.id, `ignored late report from ${staleSessionNode.id}: ${args.input.event} ${args.input.status}`)
        lastRecordOutcome = { lateIgnored: true }
        return current
      }
      lastRecordOutcome = { lateIgnored: false }
      const nodeID = resolveNodeID(current, args)
      if (!isDraftCandidateRecord(current, args.input)) writeArtifacts(root, current.id, args.input.artifacts ?? {})
      writeNodeRecordByID(root, current.id, nodeID, args.input)
      writeReportForNode(root, current, nodeID, args.input)
      if (args.input.task_graph && !isDraftCandidateRecord(current, args.input)) {
        const normalized = normalizeTaskGraph(args.input.task_graph)
        writeJson(root, current.id, "task_graph.json", normalized)
        writeJson(root, current.id, "tasks.json", normalized)
      }
      const next = applyRecord(current, args.input)
      const nodeRuns = completeNodeRuns(next.node_runs, nodeID, args.input)
      const pendingQuestion = buildPendingQuestion({
        current,
        next,
        nodeID,
        input: args.input,
      })
      const withNodes = {
        ...next,
        node_runs: nodeRuns,
        pending_question: pendingQuestion,
        status: resolveWorkflowStatusAfterNodeReport(
          { ...next, node_runs: nodeRuns },
          nodeID,
          args.input.status,
        ),
        quality_checks: mergeQualityChecksFromRecord(
          { ...next, node_runs: nodeRuns },
          args.input,
          nodeID,
        ),
      }
      const recordTaskGraphExpansion = args.input.task_graph && !isDraftCandidateRecord(current, args.input)
        ? {
            mode: "append" as const,
            reason: `${args.input.event} report produced task_graph.`,
            tasks: args.input.task_graph.tasks,
          }
        : undefined
      const withRecordTaskGraph = recordTaskGraphExpansion
        ? applyWorkflowExpansionToState(root, {
            ...withNodes,
            task_graph: current.task_graph,
          }, recordTaskGraphExpansion)
        : withNodes
      const withExpansion = args.input.workflow_expansion
        ? applyWorkflowExpansionToState(root, withRecordTaskGraph, args.input.workflow_expansion)
        : withRecordTaskGraph
      persistCurrent(withExpansion)
      appendEvent(root, withNodes.id, {
        type: "report_received",
        node_id: nodeID,
        event: args.input.event,
        status: args.input.status,
        summary: args.input.summary,
      })
      appendChangelog(root, withExpansion.id, `${args.input.event}: ${args.input.status} - ${args.input.summary}`)
      return withExpansion
    },
    cancel(args) {
      const current = args.runID ? this.readRun(args.runID) : this.readCurrent()
      if (!current) {
        throw new Error("No Superpowers workflow found to cancel.")
      }
      const now = new Date().toISOString()
      const nodeRuns = current.node_runs.map((run) => {
        const matchesTask = args.taskID && run.task_id === args.taskID
        const matchesSession = args.sessionID && run.session_id === args.sessionID
        const matchesWorkflow = !args.taskID && !args.sessionID
        if (!matchesTask && !matchesSession && !matchesWorkflow) return run
        if (!["running", "blocked", "needs_user", "interrupted", "dispatch_failed", "notification_failed"].includes(run.status)) return run
        return {
          ...run,
          status: "canceled" as const,
          closed_at: now,
          ended_at: now,
        }
      })
      const next: WorkflowState = {
        ...current,
        status: args.taskID || args.sessionID ? "waiting_user_decision" : "canceled",
        node_runs: nodeRuns,
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...current.history,
          {
            at: now,
            event: args.taskID ? "task_canceled" : args.sessionID ? "session_canceled" : "workflow_canceled",
            from: current.phase,
            to: current.phase,
            summary: args.reason,
          },
        ],
      }
      persistCurrent(next)
      appendEvent(root, next.id, {
        type: args.taskID ? "task_canceled" : args.sessionID ? "session_canceled" : "workflow_canceled",
        task_id: args.taskID,
        session_id: args.sessionID,
        reason: args.reason,
      })
      appendChangelog(root, next.id, `cancel ${args.taskID ?? args.sessionID ?? "workflow"}${args.reason ? `: ${args.reason}` : ""}`)
      return next
    },
    addNodeRun(args) {
      const current = this.readCurrent()
      if (!current) {
        throw new Error("No active Superpowers workflow. Call sp_start first.")
      }
      const existing = args.task_id
        ? current.node_runs.find((run) => run.task_id === args.task_id && run.phase === args.phase && run.agent === args.agent)
        : undefined
      const attempts = existing ? existing.attempts + 1 : 1
      const node: NodeRun = {
        id: nextDispatchNodeID(current, args.phase, args.task_id, attempts),
        task_id: args.task_id,
        phase: args.phase,
        agent: args.agent,
        primary_skill: args.primary_skill,
        session_id: args.session_id,
        status: "running",
        attempts,
        started_at: new Date().toISOString(),
      }
      const next = {
        ...current,
        status: resumableStatus(current.status),
        phase: args.phase,
        current_phase: args.phase,
        node_runs: [...current.node_runs, node],
        updated_at: new Date().toISOString(),
        state_version: nextStateVersion(),
      }
      writeNodeTask(root, current.id, node.id, args.task_markdown)
      writeReportTask(root, current.id, node.task_id ?? node.id, args.task_markdown)
      persistRun(next)
      appendEvent(root, current.id, {
        type: "session_started",
        node_id: node.id,
        task_id: node.task_id,
        agent: node.agent,
        session_id: node.session_id,
      })
      appendChangelog(root, current.id, `dispatch ${node.agent} ${node.task_id ?? node.phase} to ${node.session_id}`)
      return node
    },
    markDispatchFailed(args) {
      const current = this.readCurrent()
      if (!current) {
        throw new Error("No active Superpowers workflow. Call sp_start first.")
      }
      const now = new Date().toISOString()
      const node: NodeRun = {
        id: nextDispatchNodeID(current, args.phase, args.task_id, 1),
        task_id: args.task_id,
        phase: args.phase,
        agent: args.agent,
        primary_skill: args.primary_skill,
        session_id: args.session_id ?? "dispatch_failed",
        status: "dispatch_failed",
        attempts: 1,
        started_at: now,
        reported_at: now,
        closed_at: now,
        ended_at: now,
      }
      const next: WorkflowState = {
        ...current,
        status: workflowStatusAfterNodeFailure(current, [...current.node_runs, node]),
        phase: "dispatch-failed",
        current_phase: "dispatch-failed",
        node_runs: [...current.node_runs, node],
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...current.history,
          {
            at: now,
            event: "dispatch_failed",
            from: current.phase,
            to: "dispatch-failed",
            summary: errorMessage(args.error),
          },
        ],
      }
      writeNodeTask(root, current.id, node.id, args.task_markdown ?? `# Dispatch failed\n\n${errorMessage(args.error)}`)
      persistCurrent(next)
      appendEvent(root, current.id, {
        type: "dispatch_failed",
        node_id: node.id,
        task_id: node.task_id,
        agent: node.agent,
        session_id: node.session_id,
        error: errorMessage(args.error),
      })
      appendChangelog(root, current.id, `dispatch failed for ${node.agent} ${node.task_id ?? node.phase}: ${errorMessage(args.error)}`)
      return node
    },
    markPromptDeliveryFailed(args) {
      const current = this.readCurrent()
      if (!current) return null
      const target = current.node_runs.find((run) => run.session_id === args.session_id && run.status === "running")
      if (!target) return null
      const now = new Date().toISOString()
      const nodeRuns = current.node_runs.map((run) => {
        if (run.id !== target.id) return run
        return {
          ...run,
          status: "dispatch_failed" as const,
          reported_at: now,
          closed_at: now,
          ended_at: now,
        }
      })
      const next: WorkflowState = {
        ...current,
        status: workflowStatusAfterNodeFailure(current, nodeRuns),
        phase: "prompt-delivery-failed",
        current_phase: "prompt-delivery-failed",
        node_runs: nodeRuns,
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...current.history,
          {
            at: now,
            event: "prompt_delivery_failed",
            from: current.phase,
            to: "prompt-delivery-failed",
            summary: errorMessage(args.error),
          },
        ],
      }
      persistCurrent(next)
      appendEvent(root, current.id, {
        type: "prompt_delivery_failed",
        node_id: target.id,
        task_id: target.task_id,
        agent: target.agent,
        session_id: target.session_id,
        error: errorMessage(args.error),
      })
      appendChangelog(root, current.id, `prompt delivery failed for ${target.agent} ${target.task_id ?? target.phase}: ${errorMessage(args.error)}`)
      return nodeRuns.find((run) => run.id === target.id) ?? null
    },
    markSessionError(args) {
      const current = this.readCurrent()
      if (!current) return null
      const target = current.node_runs.find((run) => run.session_id === args.session_id && run.status === "running")
      if (!target) return null
      const now = new Date().toISOString()
      const message = errorMessage(args.error)
      const nodeStatus = sessionErrorNodeStatus(message)
      const nodeRuns = current.node_runs.map((run) => {
        if (run.id !== target.id) return run
        return {
          ...run,
          status: nodeStatus,
          reported_at: now,
          closed_at: now,
          ended_at: now,
        }
      })
      const next: WorkflowState = {
        ...current,
        status: workflowStatusAfterNodeFailure(current, nodeRuns),
        phase: "session-error",
        current_phase: "session-error",
        node_runs: nodeRuns,
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...current.history,
          {
            at: now,
            event: "session_error",
            from: current.phase,
            to: "session-error",
            summary: message,
          },
        ],
      }
      persistCurrent(next)
      appendEvent(root, current.id, {
        type: "session_error",
        node_id: target.id,
        task_id: target.task_id,
        agent: target.agent,
        session_id: target.session_id,
        error: message,
      })
      appendChangelog(root, current.id, `session error for ${target.agent} ${target.task_id ?? target.phase}: ${message}`)
      return nodeRuns.find((run) => run.id === target.id) ?? null
    },
    markNotificationFailed(args) {
      const current = this.readCurrent()
      if (!current) return null
      const target = current.node_runs.find((run) => run.id === args.node_id)
      if (!target) return null
      const now = new Date().toISOString()
      const nodeRuns = current.node_runs.map((run) => {
        if (run.id !== target.id) return run
        return {
          ...run,
          status: "notification_failed" as const,
          reported_at: now,
          closed_at: now,
          ended_at: now,
        }
      })
      const next: WorkflowState = {
        ...current,
        status: current.pending_question ? "waiting_user" : workflowStatusAfterNodeFailure(current, nodeRuns),
        node_runs: nodeRuns,
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...current.history,
          {
            at: now,
            event: "notification_failed",
            from: current.phase,
            to: current.phase,
            summary: errorMessage(args.error),
          },
        ],
      }
      persistCurrent(next)
      appendEvent(root, current.id, {
        type: "notification_failed",
        node_id: target.id,
        task_id: target.task_id,
        agent: target.agent,
        session_id: target.session_id,
        error: errorMessage(args.error),
      })
      appendChangelog(root, current.id, `notification failed for ${target.agent} ${target.task_id ?? target.phase}: ${errorMessage(args.error)}`)
      return nodeRuns.find((run) => run.id === target.id) ?? null
    },
    markLivenessExpired(args) {
      const result = this.markUnreportedExit({
        session_id: args.session_id,
        reason: "liveness_timeout",
        summary: `No progress for ${args.idle_ms}ms; marked interrupted by liveness monitor.`,
        evidence: {
          assistant_text: "",
          produced_paths: [],
          collected_at: new Date().toISOString(),
          idle_ms: args.idle_ms,
        },
      })
      return result?.node ?? null
    },
    markUnreportedExit(args) {
      const current = this.readCurrent()
      if (!current) return null
      const target = current.node_runs.find((run) => run.session_id === args.session_id && run.status === "running")
      if (!target) return null
      const now = new Date().toISOString()
      const phase = args.reason === "liveness_timeout"
        ? "liveness-timeout"
        : args.reason === "session_error"
          ? "session-error"
          : "unreported-idle"
      const event = args.reason === "liveness_timeout"
        ? "liveness_timeout"
        : args.reason === "session_error"
          ? "session_error"
          : "unreported_idle"
      const artifactRel = `nodes/${target.id}/silent-exit.json`
      const markdownRel = `nodes/${target.id}/silent-exit.md`
      const evidenceBody = {
        node_id: target.id,
        session_id: target.session_id,
        task_id: target.task_id,
        phase: target.phase,
        agent: target.agent,
        reason: args.reason,
        summary: args.summary,
        assistant_text: args.evidence.assistant_text,
        produced_paths: args.evidence.produced_paths,
        error: args.evidence.error,
        idle_ms: args.evidence.idle_ms,
        collected_at: args.evidence.collected_at,
        created_at: now,
        confidence: "partial" as const,
      }
      const nodeRoot = join(root, "runs", current.id, "nodes", target.id)
      mkdirSync(nodeRoot, { recursive: true })
      writeFileSync(join(nodeRoot, "silent-exit.json"), `${JSON.stringify(evidenceBody, null, 2)}\n`)
      writeFileSync(join(nodeRoot, "silent-exit.md"), formatSilentExitMarkdown({
        node_id: target.id,
        session_id: target.session_id,
        agent: target.agent,
        phase: target.phase,
        task_id: target.task_id,
        evidence: {
          reason: args.reason,
          assistant_text: args.evidence.assistant_text,
          produced_paths: args.evidence.produced_paths,
          summary: args.summary,
          error: args.evidence.error,
          idle_ms: args.evidence.idle_ms,
          collected_at: args.evidence.collected_at,
        },
      }))
      const fallback = {
        node_id: target.id,
        path: artifactRel,
        reason: args.summary,
        created_at: now,
      }
      const nodeStatus = args.node_status ?? "interrupted"
      const nodeRuns = current.node_runs.map((run) => {
        if (run.id !== target.id) return run
        return {
          ...run,
          status: nodeStatus,
          reported_at: now,
          closed_at: now,
          ended_at: now,
        }
      })
      const next: WorkflowState = {
        ...current,
        status: workflowStatusAfterNodeFailure(current, nodeRuns),
        phase,
        current_phase: phase,
        node_runs: nodeRuns,
        fallback_summaries: [
          ...(current.fallback_summaries ?? []).filter((item) => item.node_id !== target.id),
          fallback,
        ],
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...current.history,
          {
            at: now,
            event,
            from: current.phase,
            to: phase,
            summary: args.summary,
          },
        ],
      }
      persistCurrent(next)
      appendEvent(root, current.id, {
        type: event,
        node_id: target.id,
        task_id: target.task_id,
        agent: target.agent,
        session_id: target.session_id,
        reason: args.reason,
        node_status: nodeStatus,
        idle_ms: args.evidence.idle_ms,
        artifact_path: artifactRel,
        markdown_path: markdownRel,
        produced_paths: args.evidence.produced_paths,
      })
      appendChangelog(root, current.id, `${event} for ${target.agent} ${target.task_id ?? target.phase}: ${args.summary}`)
      return {
        node: nodeRuns.find((run) => run.id === target.id)!,
        artifact_path: artifactRel,
      }
    },
    recordAuditEvent(args) {
      const current = this.readCurrent()
      if (!current) return null
      const now = new Date().toISOString()
      const next: WorkflowState = {
        ...current,
        updated_at: now,
        state_version: nextStateVersion(),
        history: [
          ...current.history,
          {
            at: now,
            event: args.event,
            from: current.phase,
            to: current.phase,
            summary: args.summary,
          },
        ],
      }
      persistCurrent(next)
      appendEvent(root, current.id, {
        type: args.event,
        summary: args.summary,
      })
      appendChangelog(root, current.id, `${args.event}: ${args.summary}`)
      return next
    },
    reset() {
      const currentPath = join(root, "current.json")
      if (existsSync(currentPath)) rmSync(currentPath)
      loaded = true
      currentRunID = undefined
    },
  }
}

function readStateFromDisk(root: string, runID: string): WorkflowState | null {
  const statePath = join(root, "runs", runID, "state.json")
  if (!existsSync(statePath)) return null
  const state = JSON.parse(readFileSync(statePath, "utf8")) as WorkflowState
  return {
    ...state,
    state_version: state.state_version ?? `${state.updated_at}:legacy`,
  }
}

type StartupReconciliation = {
  state: WorkflowState
  changed: boolean
  reason: string
  interruptedIDs: string[]
  recoveredWorkflowRunning: boolean
}

function reconcileStartupState(state: WorkflowState, args: { reason: string }): StartupReconciliation {
  const interrupted = state.node_runs.filter((node) => node.status === "running")
  const recoveredWorkflowRunning = state.activation === "active" && state.status === "running"
  if (interrupted.length === 0 && !recoveredWorkflowRunning) {
    return {
      state,
      changed: false,
      reason: args.reason,
      interruptedIDs: [],
      recoveredWorkflowRunning: false,
    }
  }

  const now = new Date().toISOString()
  const interruptedIDs = new Set(interrupted.map((node) => node.id))
  return {
    state: {
      ...state,
      status: "recovered_unknown",
      updated_at: now,
      state_version: nextStateVersion(),
      node_runs: state.node_runs.map((node) => {
        if (!interruptedIDs.has(node.id)) return node
        return {
          ...node,
          status: "interrupted" as const,
          closed_at: now,
          ended_at: now,
        }
      }),
      history: [
        ...state.history,
        {
          at: now,
          event: interruptedIDs.size > 0 ? "startup_recovered_interrupted_nodes" : "startup_recovered_running_workflow",
          from: state.phase,
          to: state.phase,
          summary: args.reason,
        },
      ],
    },
    changed: true,
    reason: args.reason,
    interruptedIDs: [...interruptedIDs],
    recoveredWorkflowRunning,
  }
}

function appendStartupRecoveryEvidence(
  root: string,
  state: WorkflowState,
  reconciliation: StartupReconciliation,
  reason: string,
): void {
  const eventType = reconciliation.interruptedIDs.length > 0
    ? "startup_recovered_interrupted_nodes"
    : "startup_recovered_running_workflow"
  appendEvent(root, state.id, {
    type: eventType,
    node_ids: reconciliation.interruptedIDs,
    workflow_status_recovered: reconciliation.recoveredWorkflowRunning,
    reason,
  })
  if (reconciliation.interruptedIDs.length > 0) {
    appendChangelog(root, state.id, `startup recovered interrupted nodes ${reconciliation.interruptedIDs.join(", ")}: ${reason}`)
    return
  }
  appendChangelog(root, state.id, `startup recovered workflow running status: ${reason}`)
}

function addStartupFallbackSummaries(
  root: string,
  state: WorkflowState,
  reconciliation: StartupReconciliation,
  reason: string,
): WorkflowState {
  if (reconciliation.interruptedIDs.length === 0) return state
  const now = new Date().toISOString()
  const existing = new Set(state.fallback_summaries?.map((item) => item.node_id) ?? [])
  const summaries = [...(state.fallback_summaries ?? [])]
  for (const nodeID of reconciliation.interruptedIDs) {
    if (existing.has(nodeID)) continue
    const node = state.node_runs.find((item) => item.id === nodeID)
    const path = `nodes/${nodeID}/fallback-summary.json`
    const body = {
      node_id: nodeID,
      session_id: node?.session_id,
      task_id: node?.task_id,
      phase: node?.phase,
      agent: node?.agent,
      status: "interrupted",
      reason,
      created_at: now,
      confidence: "partial",
      summary: "This node was running before startup recovery. No terminal sp_report was recorded, so controller must retry, inspect, accept partial evidence, reprepare, or cancel.",
    }
    const fullPath = join(root, "runs", state.id, path)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, `${JSON.stringify(body, null, 2)}\n`)
    summaries.push({ node_id: nodeID, path, reason, created_at: now })
  }
  return {
    ...state,
    fallback_summaries: summaries,
  }
}

function applyWorkflowExpansionToState(
  root: string,
  state: WorkflowState,
  expansion: WorkflowExpansionPatch,
): WorkflowState {
  const now = new Date().toISOString()
  const stateWithBaseline = state.workflow_spec ? state : withBaselineWorkflowSpec(state)
  const allowed = stateWithBaseline.workflow_spec?.auto_expansion.allow ?? !stateWithBaseline.workflow.endsWith("-only")
  writeJson(root, state.id, "workflow-expansion-latest.json", expansion)
  if (!allowed) {
    return {
      ...stateWithBaseline,
      status: "waiting_controller_decision",
      pending_workflow_expansion: expansion,
      next: "Controller must decide whether to apply workflow_expansion, replace orchestration, retry, or mark blocked.",
      updated_at: now,
      state_version: nextStateVersion(),
      history: [
        ...state.history,
        {
          at: now,
          event: "workflow_expansion_waiting_controller",
          from: state.phase,
          to: state.phase,
          summary: expansion.reason ?? "Node reported workflow expansion while auto expansion is disabled.",
        },
      ],
    }
  }

  const existingTasks = stateWithBaseline.task_graph?.tasks ?? []
  const nextTasks = expansion.tasks?.length
    ? expansion.mode === "replace"
      ? expansion.tasks
      : mergeTasks(existingTasks, expansion.tasks)
    : existingTasks
  const expansionNodes = [
    ...(expansion.nodes ?? []),
    ...(nextTasks.length ? workflowNodesForTasks(nextTasks, stateWithBaseline.workflow_spec?.orchestration.nodes.find((node) => node.agent === "sp-planner")?.id) : []),
  ]
  const planNodeID = stateWithBaseline.workflow_spec?.orchestration.nodes.find((node) => node.agent === "sp-planner")?.id
  const expansionEdges = nextTasks.length ? buildTaskGraphSpecEdges(workflowNodesForTasks(nextTasks, planNodeID), planNodeID) ?? [] : []
  const nextWorkflowSpec = stateWithBaseline.workflow_spec
    ? (expansionNodes.length || expansion.documents?.length)
      ? {
        ...stateWithBaseline.workflow_spec,
        spec_version: nextSpecVersion(stateWithBaseline.workflow_spec.spec_version),
        updated_at: now,
        orchestration: {
          ...stateWithBaseline.workflow_spec.orchestration,
          nodes: expansion.mode === "replace"
            ? expansionNodes
            : mergeNodes(stateWithBaseline.workflow_spec.orchestration.nodes, expansionNodes),
          edges: expansion.mode === "replace"
            ? expansionEdges
            : mergeEdges(stateWithBaseline.workflow_spec.orchestration.edges ?? [], expansionEdges),
          documents: expansion.documents?.length
            ? mergeDocuments(stateWithBaseline.workflow_spec.orchestration.documents ?? [], expansion.documents)
            : stateWithBaseline.workflow_spec.orchestration.documents,
        },
      }
      : stateWithBaseline.workflow_spec
    : expansionNodes.length
      ? createWorkflowSpecFromExpansion(stateWithBaseline, expansionNodes, expansion.documents ?? [], allowed, now)
      : undefined
  const next: WorkflowState = {
    ...stateWithBaseline,
    pending_workflow_expansion: undefined,
    task_graph: nextTasks.length ? normalizeTaskGraph({ tasks: nextTasks }) : state.task_graph,
    workflow_spec: nextWorkflowSpec,
    documents: expansion.documents?.length ? [...(state.documents ?? []), ...expansion.documents] : state.documents,
    updated_at: now,
    state_version: nextStateVersion(),
    history: [
      ...state.history,
      {
        at: now,
        event: "workflow_expansion_applied",
        from: state.phase,
        to: state.phase,
        summary: expansion.reason ?? "Applied node-reported workflow expansion.",
      },
    ],
  }
  if (next.task_graph) {
    writeJson(root, next.id, "task_graph.json", next.task_graph)
    writeJson(root, next.id, "tasks.json", next.task_graph)
  }
  if (next.workflow_spec) writeJson(root, next.id, "workflow-spec.json", next.workflow_spec)
  appendEvent(root, next.id, {
    type: "workflow_expansion_applied",
    reason: expansion.reason,
    task_count: expansion.tasks?.length ?? 0,
    node_count: expansion.nodes?.length ?? 0,
  })
  return next
}

function mergeTasks(existing: NonNullable<WorkflowState["task_graph"]>["tasks"], incoming: NonNullable<WorkflowState["task_graph"]>["tasks"]) {
  const byID = new Map(existing.map((task) => [task.id, task]))
  for (const task of incoming) byID.set(task.id, task)
  return [...byID.values()]
}

function mergeNodes(existing: NonNullable<WorkflowState["workflow_spec"]>["orchestration"]["nodes"], incoming: NonNullable<WorkflowState["workflow_spec"]>["orchestration"]["nodes"]) {
  const byID = new Map(existing.map((node) => [node.id, node]))
  for (const node of incoming) byID.set(node.id, node)
  return [...byID.values()]
}

function mergeDocuments(existing: WorkflowDocumentSpec[], incoming: WorkflowDocumentSpec[]): WorkflowDocumentSpec[] {
  const byID = new Map(existing.map((document) => [document.id, document]))
  for (const document of incoming) byID.set(document.id, document)
  return [...byID.values()]
}

function mergeEdges(
  existing: NonNullable<WorkflowState["workflow_spec"]>["orchestration"]["edges"],
  incoming: NonNullable<WorkflowState["workflow_spec"]>["orchestration"]["edges"],
) {
  const safeExisting = existing ?? []
  const seen = new Set(safeExisting.map((edge) => `${edge.from}->${edge.to}:${edge.condition ?? "passed"}`))
  const merged = [...safeExisting]
  for (const edge of incoming ?? []) {
    const key = `${edge.from}->${edge.to}:${edge.condition ?? "passed"}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(edge)
  }
  return merged
}

function withBaselineWorkflowSpec(state: WorkflowState): WorkflowState {
  if (state.workflow_spec) return state
  const template = findBuiltInWorkflowTemplate(state.workflow)
  if (!template) return state
  const workflowSpec = createWorkflowSpec({
    id: `${state.id}-workflow-spec`,
    kind: "built_in_workflow",
    templateID: template.id,
    orchestration: template.orchestration,
    autoExpansionAllow: template.default_start_config.auto_expansion.allow,
    autoExpansionReason: template.default_start_config.auto_expansion.reason,
  })
  return {
    ...state,
    workflow_spec: workflowSpec,
  }
}

function workflowNodesForTasks(
  tasks: NonNullable<WorkflowState["task_graph"]>["tasks"],
  planNodeID?: string,
): WorkflowNodeSpec[] {
  return buildTaskGraphSpecNodes(tasks, planNodeID)
}

function nextSpecVersion(current: number | undefined): number {
  return (current ?? 0) + 1
}

function createWorkflowSpecFromExpansion(
  state: WorkflowState,
  nodes: WorkflowNodeSpec[],
  documents: WorkflowDocumentSpec[],
  autoExpansionAllow: boolean,
  now: string,
): WorkflowSpec {
  return {
    id: `${state.id}-workflow-spec`,
    version: "v5",
    spec_version: 1,
    stage: "execution",
    source: { kind: "report_expansion" },
    template_id: state.workflow,
    kind: "orchestration",
    title: state.goal,
    auto_expansion: {
      allow: autoExpansionAllow,
      source: "orchestration",
      reason: "Created from a validated report expansion.",
    },
    orchestration: {
      id: `${state.id}-orchestration`,
      title: state.goal,
      nodes,
      edges: buildTaskGraphSpecEdges(nodes),
      documents,
    },
    created_at: now,
    updated_at: now,
  }
}

function resumableStatus(status: WorkflowState["status"]): WorkflowState["status"] {
  if (status === "passed" || status === "canceled") return status
  return "running"
}

function statusForControllerDecision(
  current: WorkflowState,
  decision: ControllerDecision,
): WorkflowState["status"] {
  switch (decision.kind) {
    case "continue_existing_graph":
    case "retry_node":
    case "apply_workflow_patch":
    case "replace_orchestration":
      return resumableStatus(current.status)
    case "accept_partial_result":
      return "passed"
    case "mark_blocked":
    case "request_reprepare":
      return "blocked"
  }
}

function phaseForControllerDecision(current: WorkflowState, decision: ControllerDecision): string {
  switch (decision.kind) {
    case "continue_existing_graph":
      return current.phase
    case "retry_node":
      return "retrying-node"
    case "apply_workflow_patch":
      return "workflow-patch-applied"
    case "replace_orchestration":
      return "workflow-orchestration-replaced"
    case "accept_partial_result":
      return "partial-result-accepted"
    case "mark_blocked":
      return "controller-blocked"
    case "request_reprepare":
      return "reprepare-requested"
  }
}

function nextForControllerDecision(decision: ControllerDecision): string | undefined {
  if (decision.kind === "request_reprepare") return "Call sp_prepare with a revised task brief."
  if (decision.kind === "mark_blocked") return decision.required_user_action
  if (decision.kind === "accept_partial_result") return "Report the accepted partial result to the user."
  if (decision.kind === "apply_workflow_patch") return "Continue with the patched workflow graph."
  if (decision.kind === "replace_orchestration") return "Continue with the replacement orchestration."
  return undefined
}

function nextStateVersion(): string {
  return `${new Date().toISOString()}:${randomUUID()}`
}

function createWorkflowState(args: {
  id: string
  project: string
  workflow: WorkflowKind
  entrypoint: WorkflowEntrypoint
  goal: string
  parentSessionID: string
  activation: WorkflowState["activation"]
  prepareMode?: PrepareMode
}): WorkflowState {
  const now = new Date().toISOString()
  const mode = modeForWorkflow(args.workflow, args.entrypoint)
  return {
    id: args.id,
    project: args.project,
    session: args.parentSessionID,
    parent_session_id: args.parentSessionID,
    activation: args.activation,
    prepare_mode: args.prepareMode,
    workflow: args.workflow,
    entrypoint: args.entrypoint,
    limited_context: args.entrypoint !== args.workflow,
    mode,
    phase: args.activation === "draft" ? "plan" : "intake",
    current_phase: args.activation === "draft" ? "plan" : "intake",
    status: args.activation === "draft" ? "running" : "intake",
    goal: args.goal,
    created_at: now,
    updated_at: now,
    state_version: `${now}:created`,
    gates: {},
    artifacts: {},
    node_runs: [],
    history: [{ at: now, event: "created", to: args.workflow }],
  }
}

function initializeRunRoot(runRoot: string): void {
  mkdirSync(join(runRoot, "artifacts"), { recursive: true })
  mkdirSync(join(runRoot, "nodes"), { recursive: true })
}

function runRootFor(root: string, runID: string): string {
  return join(root, "runs", runID)
}

function modeForWorkflow(workflow: WorkflowKind, entrypoint?: WorkflowEntrypoint): WorkflowMode {
  if (entrypoint === "execute") return "execute"
  if (entrypoint === "plan") return "plan"
  if (entrypoint === "debug") return "debug"
  if (entrypoint === "review") return "review"
  if (entrypoint === "verify") return "verify-finish"
  if (entrypoint === "investigate") return "parallel-investigate"
  switch (workflow) {
    case "bugfix":
    case "debug":
      return "debug"
    case "design-only":
      return "design"
    case "plan-only":
      return "plan"
    case "review-only":
    case "review":
      return "review"
    case "verify-finish":
      return "verify-finish"
    case "parallel-investigate":
      return "parallel-investigate"
    case "single-agent":
      return "execute"
    default:
      return "design"
  }
}

function writeState(root: string, state: WorkflowState): void {
  const statePath = join(root, "runs", state.id, "state.json")
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
  writeFileSync(join(root, "runs", state.id, "workflow.json"), `${JSON.stringify(state, null, 2)}\n`)
  writeJson(root, state.id, "sessions.json", { sessions: state.node_runs })
  if (state.task_graph) writeJson(root, state.id, "tasks.json", state.task_graph)
  if (state.workflow_spec) writeJson(root, state.id, "workflow-spec.json", state.workflow_spec)
  writeDocumentsManifest(root, state)
}

function writeDocumentsManifest(root: string, state: WorkflowState): void {
  writeJson(root, state.id, "documents.json", buildDocumentsManifest(root, state))
}

function buildDocumentsManifest(root: string, state: WorkflowState) {
  const now = new Date().toISOString()
  const runRoot = join(root, "runs", state.id)
  const docs = new Map<string, {
    id: string
    path: string
    kind: string
    producer: string
    consumer?: string[]
    status?: string
    node_id?: string
    task_id?: string
    updated_at: string
  }>()
  const add = (item: {
    id: string
    path: string
    kind: string
    producer: string
    consumer?: string[]
    status?: string
    node_id?: string
    task_id?: string
  }) => {
    if (!existsSync(join(runRoot, item.path))) return
    docs.set(item.id, { ...item, updated_at: now })
  }
  add({ id: "request", path: "request.md", kind: "request", producer: "controller", consumer: ["controller", "node"], status: "current" })
  add({ id: "task", path: "task.md", kind: "task", producer: "plugin", consumer: ["controller", "node"], status: "current" })
  add({ id: "proposal", path: "proposal.md", kind: "proposal", producer: "plugin", consumer: ["controller"], status: state.activation === "draft" ? "draft" : "approved" })
  add({ id: "workflow_spec", path: "workflow-spec.json", kind: "workflow_spec", producer: "plugin", consumer: ["controller", "node"], status: "current" })
  add({ id: "spec", path: "spec.md", kind: "spec", producer: "node", consumer: ["planner", "implementer"], status: state.gates.spec_written ? "approved" : "candidate" })
  add({ id: "plan", path: "plan.md", kind: "plan", producer: "node", consumer: ["implementer", "reviewer", "verifier"], status: state.gates.plan_written ? "approved" : "candidate" })
  add({ id: "task_graph", path: "task_graph.json", kind: "task_graph", producer: "node", consumer: ["plugin", "controller"], status: "current" })
  add({ id: "tasks", path: "tasks.json", kind: "task_graph", producer: "plugin", consumer: ["plugin", "controller"], status: "current" })
  for (const node of state.node_runs) {
    add({
      id: `node_${node.id}_task`,
      path: `nodes/${node.id}/task.md`,
      kind: "node_task",
      producer: "plugin",
      consumer: [node.agent],
      status: node.status === "running" ? "current" : "historical",
      node_id: node.id,
      task_id: node.task_id,
    })
    add({
      id: `node_${node.id}_record`,
      path: `nodes/${node.id}/record.json`,
      kind: "node_record",
      producer: "node",
      consumer: ["plugin", "controller"],
      status: node.status === "running" ? "current" : "historical",
      node_id: node.id,
      task_id: node.task_id,
    })
    add({
      id: `node_${node.id}_fallback`,
      path: `nodes/${node.id}/fallback-summary.json`,
      kind: "fallback_summary",
      producer: "recovery",
      consumer: ["controller"],
      status: "candidate",
      node_id: node.id,
      task_id: node.task_id,
    })
  }
  for (const item of state.documents ?? []) {
    docs.set(item.id, { ...item, producer: item.producer, updated_at: item.updated_at ?? now })
  }
  return {
    run_id: state.id,
    updated_at: now,
    documents: [...docs.values()].sort((a, b) => a.path.localeCompare(b.path)),
  }
}

function writeRunMarkdown(root: string, run: string, filename: string, body: string): void {
  const path = join(root, "runs", run, filename)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`)
}

function writeJson(root: string, run: string, filename: string, value: unknown): void {
  const path = join(root, "runs", run, filename)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeCurrent(root: string, run: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "current.json"), `${JSON.stringify({ run }, null, 2)}\n`)
}

function writeArtifacts(root: string, run: string, artifacts: NonNullable<WorkflowRecord["artifacts"]>): void {
  for (const [name, body] of Object.entries(artifacts)) {
    const artifactPath = join(root, "runs", run, "artifacts", `${name}.md`)
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, `${body.trim()}\n`)
    const flatName = flatArtifactFilename(name)
    if (flatName) writeRunMarkdown(root, run, flatName, body)
  }
}

function isDraftCandidateRecord(state: WorkflowState, record: WorkflowRecord): boolean {
  return state.activation === "draft" && (record.event === "design" || record.event === "plan")
}

function latestCandidateRecord(
  root: string,
  run: string,
  event: Extract<WorkflowRecord["event"], "design" | "plan">,
): { nodeID: string; record: WorkflowRecord } {
  const nodesRoot = join(root, "runs", run, "nodes")
  if (!existsSync(nodesRoot)) throw new Error(`No candidate ${event} records found for run ${run}.`)
  const candidates = readdirSync(nodesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
  for (const nodeID of candidates) {
    const recordPath = join(nodesRoot, nodeID, "record.json")
    if (!existsSync(recordPath)) continue
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as WorkflowRecord
    if (record.event === event && record.status === "passed") return { nodeID, record }
  }
  throw new Error(`No passed candidate ${event} record found for run ${run}.`)
}

function copySourceArtifacts(
  root: string,
  sourceRun: string,
  targetRun: string,
  artifacts: WorkflowState["artifacts"],
): Partial<Record<WorkflowArtifact, string>> {
  const refs: Partial<Record<WorkflowArtifact, string>> = {}
  for (const [name, ref] of Object.entries(artifacts) as Array<[WorkflowArtifact, string]>) {
    const sourcePath = join(root, "runs", sourceRun, "artifacts", ref)
    if (!existsSync(sourcePath)) continue
    const body = readFileSync(sourcePath, "utf8")
    const targetRef = `${name}.md`
    const targetPath = join(root, "runs", targetRun, "artifacts", targetRef)
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, body.endsWith("\n") ? body : `${body}\n`)
    const flatName = flatArtifactFilename(name)
    if (flatName) writeRunMarkdown(root, targetRun, flatName, body)
    refs[name] = targetRef
  }
  return refs
}

function flatArtifactFilename(name: string): string | undefined {
  switch (name) {
    case "spec":
      return "spec.md"
    case "plan":
      return "plan.md"
    default:
      return undefined
  }
}

function writeNodeRecord(root: string, run: string, index: number, record: WorkflowRecord): void {
  const node = `${String(index).padStart(3, "0")}-${record.event}`
  writeNodeRecordByID(root, run, node, record)
}

function writeNodeRecordByID(root: string, run: string, node: string, record: WorkflowRecord): void {
  const nodeRoot = join(root, "runs", run, "nodes", node)
  mkdirSync(nodeRoot, { recursive: true })
  writeFileSync(join(nodeRoot, "record.json"), `${JSON.stringify(record, null, 2)}\n`)
  writeFileSync(join(nodeRoot, "output.md"), `${record.summary.trim()}\n`)
}

function writeNodeTask(root: string, run: string, node: string, body: string): void {
  const nodeRoot = join(root, "runs", run, "nodes", node)
  mkdirSync(nodeRoot, { recursive: true })
  writeFileSync(join(nodeRoot, "task.md"), body.endsWith("\n") ? body : `${body}\n`)
}

function writeReportTask(root: string, run: string, taskID: string, body: string): void {
  const reportRoot = join(root, "runs", run, "reports", taskID)
  mkdirSync(reportRoot, { recursive: true })
  writeFileSync(join(reportRoot, "task.md"), body.endsWith("\n") ? body : `${body}\n`)
}

function writeReportForNode(root: string, state: WorkflowState, nodeID: string, record: WorkflowRecord): void {
  const nodeRun = state.node_runs.find((run) => run.id === nodeID)
  const taskID = nodeRun?.task_id ?? nodeID
  const filename = reportFilenameForEvent(record.event)
  if (!filename) return
  const reportRoot = join(root, "runs", state.id, "reports", taskID)
  mkdirSync(reportRoot, { recursive: true })
  const body = record.artifacts?.[artifactForReportEvent(record.event)] ?? record.findings ?? record.checks ?? record.summary
  writeFileSync(join(reportRoot, filename), `${body.trim()}\n`)
}

function reportFilenameForEvent(event: WorkflowRecord["event"]): string | undefined {
  switch (event) {
    case "implementation":
    case "debug":
    case "question":
      return "report.md"
    case "investigation":
      return "investigation.md"
    case "acceptance":
      return "acceptance.md"
    case "code-review":
      return "code_review.md"
    case "verification":
      return "verification.md"
    case "finish":
      return "finish.md"
    default:
      return undefined
  }
}

function artifactForReportEvent(event: WorkflowRecord["event"]): keyof NonNullable<WorkflowRecord["artifacts"]> {
  switch (event) {
    case "acceptance":
      return "acceptance"
    case "code-review":
      return "code_review"
    case "verification":
      return "verification_log"
    case "finish":
      return "finish_note"
    case "investigation":
      return "investigation"
    case "debug":
      return "root_cause"
    case "implementation":
      return "patch_summary"
    default:
      return "request"
  }
}

function appendChangelog(root: string, run: string, message: string): void {
  const path = join(root, "runs", run, "changelog.md")
  mkdirSync(dirname(path), { recursive: true })
  const current = existsSync(path) ? readFileSync(path, "utf8") : "# Changelog\n\n"
  writeFileSync(path, `${current.trimEnd()}\n- ${new Date().toISOString()} ${message}\n`)
}

function appendEvent(root: string, run: string, event: Record<string, unknown>): void {
  const path = join(root, "runs", run, "events.jsonl")
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
}

function nextNodeID(state: WorkflowState, event: string): string {
  const running = [...state.node_runs].reverse().find((run) => run.status === "running")
  if (running) return running.id
  const nodeIndex = state.history.filter((entry) => entry.event !== "created").length + 1
  return `${String(nodeIndex).padStart(3, "0")}-${event}`
}

function resolveNodeID(
  state: WorkflowState,
  args: { nodeID?: string; sessionID?: string; agent?: string; input: WorkflowRecord },
): string {
  if (args.nodeID) return args.nodeID
  const running = state.node_runs.filter((run) => run.status === "running")
  const eventPhase = phaseForRecordEvent(args.input.event)

  if (args.sessionID) {
    const sessionMatches = running.filter((run) => run.session_id === args.sessionID)
    const resolved = resolveUniqueRunningNode(sessionMatches, eventPhase, args.agent)
    if (resolved) return resolved.id
    if (sessionMatches.length > 0) {
      throw new Error(`sp_report rejected: multiple running nodes match session ${args.sessionID}; pass nodeID explicitly`)
    }
  }

  const eventMatches = running.filter((run) => run.phase === eventPhase)
  const eventResolved = resolveUniqueRunningNode(eventMatches, eventPhase, args.agent)
  if (eventResolved) return eventResolved.id

  if (running.length === 1) return running[0].id
  if (running.length > 1) {
    throw new Error("sp_report rejected: multiple running nodes are active; report with session context or explicit nodeID")
  }

  return nextNodeID(state, args.input.event)
}

function resolveUniqueRunningNode(nodes: NodeRun[], phase: string, agent?: string): NodeRun | undefined {
  if (nodes.length === 1) return nodes[0]
  if (nodes.length === 0) return undefined
  const phaseMatches = nodes.filter((run) => run.phase === phase)
  if (phaseMatches.length === 1) return phaseMatches[0]
  if (agent) {
    const agentMatches = phaseMatches.length > 0 ? phaseMatches.filter((run) => run.agent === agent) : nodes.filter((run) => run.agent === agent)
    if (agentMatches.length === 1) return agentMatches[0]
  }
  return undefined
}

function phaseForRecordEvent(event: WorkflowRecord["event"]): string {
  switch (event) {
    case "implementation":
      return "implement"
    case "code-review":
      return "code-review"
    case "red-test":
      return "red-test"
    default:
      return event
  }
}

function parentSessionFields(state: WorkflowState, parentSessionID: string, at: string): Pick<WorkflowState, "session" | "parent_session_id" | "history"> {
  if (state.parent_session_id === parentSessionID && state.session === parentSessionID) {
    return {
      session: state.session,
      parent_session_id: state.parent_session_id,
      history: state.history,
    }
  }
  return {
    session: parentSessionID,
    parent_session_id: parentSessionID,
    history: [
      ...state.history,
      {
        at,
        event: "parent_session_rebound",
        from: state.phase,
        to: state.phase,
        summary: `Parent session rebound from ${state.parent_session_id} to ${parentSessionID}.`,
      },
    ],
  }
}

function nextDispatchNodeID(state: WorkflowState, phase: string, taskID: string | undefined, attempts: number): string {
  const index = state.node_runs.length + 1
  const task = taskID ? `-${taskID}` : ""
  const retry = attempts > 1 ? `-retry-${attempts}` : ""
  return `${String(index).padStart(3, "0")}-${phase}${task}${retry}`
}

function completeNodeRuns(nodeRuns: NodeRun[], nodeID: string, record: WorkflowRecord): NodeRun[] {
  const reportedAt = new Date().toISOString()
  return nodeRuns.map((run) => {
    if (run.id !== nodeID) return run
    if (record.status === "progress") {
      return {
        ...run,
        reported_at: reportedAt,
        record_path: `nodes/${nodeID}/record.json`,
      }
    }
    return {
      ...run,
      status: record.status,
      reported_at: reportedAt,
      closed_at: reportedAt,
      ended_at: reportedAt,
      record_path: `nodes/${nodeID}/record.json`,
    }
  })
}

function buildPendingQuestion(args: {
  current: WorkflowState
  next: WorkflowState
  nodeID: string
  input: WorkflowRecord
}): WorkflowState["pending_question"] {
  if (args.input.status === "needs_user" && args.input.question) {
    return {
      ...args.input.question,
      source_node_id: args.nodeID,
    }
  }
  if (args.current.activation === "draft" && args.input.event === "design" && args.input.status === "passed") {
    return {
      prompt: "Design candidate is ready. Review the candidate output, then either restart through the v5 prepared-task confirmation path or request revision before planning.",
      options: [
        { label: "start_confirmed_task", description: "Use sp_prepare, user confirmation, then sp_start(start_prepared_task) with confirmation and start_config." },
        { label: "revise_design", description: "Ask the designer to revise the candidate design." },
      ],
      source_node_id: args.nodeID,
    }
  }
  if (args.current.activation === "draft" && args.input.event === "plan" && args.input.status === "passed") {
    return {
      prompt: "Plan candidate and task graph are ready. Review them, then either restart through the v5 prepared-task confirmation path or request revision before implementation.",
      options: [
        { label: "start_confirmed_task", description: "Use sp_prepare, user confirmation, then sp_start(start_prepared_task) with confirmation and start_config." },
        { label: "revise_plan", description: "Ask the planner to revise the candidate plan." },
      ],
      source_node_id: args.nodeID,
    }
  }
  return args.next.pending_question
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Unknown error."
}
