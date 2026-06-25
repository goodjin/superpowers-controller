import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { applyRecord, createInitialState } from "./transitions"
import { normalizeTaskGraph } from "./task-graph"
import type { NodeRun, WorkflowEntrypoint, WorkflowKind, WorkflowMode, WorkflowRecord, WorkflowState } from "./types"

export type ProjectStore = {
  root: string
  readCurrent(): WorkflowState | null
  readRun(runID: string): WorkflowState | null
  listRuns(): WorkflowState[]
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
  }): WorkflowState
  activateRun(args: {
    runID: string
    parentSessionID: string
  }): WorkflowState
  record(record: WorkflowRecord): WorkflowState
  recordNodeResult(args: { nodeID?: string; input: WorkflowRecord }): WorkflowState
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

export function createProjectStore(project: string): ProjectStore {
  const root = join(project, ".opencode", "superpowers")
  return {
    root,
    readCurrent() {
      const currentPath = join(root, "current.json")
      if (!existsSync(currentPath)) return null
      const pointer = JSON.parse(readFileSync(currentPath, "utf8")) as { run: string }
      return this.readRun(pointer.run)
    },
    readRun(runID) {
      const statePath = join(root, "runs", runID, "state.json")
      if (!existsSync(statePath)) return null
      return JSON.parse(readFileSync(statePath, "utf8")) as WorkflowState
    },
    listRuns() {
      const runsRoot = join(root, "runs")
      if (!existsSync(runsRoot)) return []
      return readdirSync(runsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readRun(entry.name))
        .filter((state): state is WorkflowState => Boolean(state))
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
      writeState(root, state)
      writeCurrent(root, state.id)
      writeRunMarkdown(root, state.id, "request.md", `# Request\n\n${args.goal.trim()}\n`)
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
      writeState(root, state)
      writeCurrent(root, state.id)
      writeRunMarkdown(root, state.id, "request.md", args.request)
      writeRunMarkdown(root, state.id, "task.md", args.request)
      writeRunMarkdown(root, state.id, "proposal.md", args.proposal)
      appendEvent(root, state.id, { type: "workflow_started", workflow: state.workflow, entrypoint: state.entrypoint })
      appendChangelog(root, state.id, `created ${args.workflow} workflow from ${args.entrypoint}`)
      return state
    },
    prepareRun(args) {
      const state = createWorkflowState({
        id: randomUUID(),
        project,
        workflow: args.workflow,
        entrypoint: args.entrypoint,
        goal: args.goal,
        parentSessionID: args.parentSessionID,
        activation: "draft",
      })
      initializeRunRoot(runRootFor(root, state.id))
      writeState(root, state)
      writeCurrent(root, state.id)
      writeRunMarkdown(root, state.id, "request.md", args.request)
      writeRunMarkdown(root, state.id, "task.md", args.request)
      writeRunMarkdown(root, state.id, "proposal.md", args.proposal)
      appendEvent(root, state.id, { type: "workflow_prepared", workflow: state.workflow, entrypoint: state.entrypoint })
      appendChangelog(root, state.id, `prepared ${args.workflow} workflow from ${args.entrypoint}`)
      return state
    },
    activateRun(args) {
      const current = this.readRun(args.runID)
      if (!current) {
        throw new Error(`No Superpowers workflow found for run ${args.runID}.`)
      }
      const next: WorkflowState = {
        ...current,
        activation: "active",
        session: args.parentSessionID,
        parent_session_id: args.parentSessionID,
        phase: current.phase === "awaiting-plan-approval" ? "plan-complete" : current.phase,
        current_phase: current.current_phase === "awaiting-plan-approval" ? "plan-complete" : current.current_phase,
        status: current.status === "waiting_user" ? "running" : current.status,
        pending_question: undefined,
        updated_at: new Date().toISOString(),
      }
      writeState(root, next)
      writeCurrent(root, next.id)
      appendChangelog(root, next.id, `activated ${next.workflow} workflow from ${next.entrypoint}`)
      return next
    },
    record(record) {
      const current = this.readCurrent()
      if (!current) {
        throw new Error("No active Superpowers workflow. Call sp_status or sp_prepare first.")
      }
      writeArtifacts(root, current.id, record.artifacts ?? {})
      const nodeIndex = current.history.filter((entry) => entry.event !== "created").length + 1
      writeNodeRecord(root, current.id, nodeIndex, record)
      if (record.task_graph) {
        const normalized = normalizeTaskGraph(record.task_graph)
        writeJson(root, current.id, "task_graph.json", normalized)
      }
      const next = applyRecord(current, record)
      writeState(root, next)
      writeCurrent(root, next.id)
      appendChangelog(root, next.id, `${record.event}: ${record.status} - ${record.summary}`)
      return next
    },
    recordNodeResult(args) {
      const current = this.readCurrent()
      if (!current) {
        throw new Error("No active Superpowers workflow. Call sp_start first.")
      }
      const nodeID = args.nodeID ?? nextNodeID(current, args.input.event)
      writeArtifacts(root, current.id, args.input.artifacts ?? {})
      writeNodeRecordByID(root, current.id, nodeID, args.input)
      writeReportForNode(root, current, nodeID, args.input)
      if (args.input.task_graph) {
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
      }
      writeState(root, withNodes)
      writeCurrent(root, withNodes.id)
      appendEvent(root, withNodes.id, {
        type: "report_received",
        node_id: nodeID,
        event: args.input.event,
        status: args.input.status,
        summary: args.input.summary,
      })
      appendChangelog(root, withNodes.id, `${args.input.event}: ${args.input.status} - ${args.input.summary}`)
      return withNodes
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
        if (!["running", "blocked", "needs_user"].includes(run.status)) return run
        return {
          ...run,
          status: "blocked" as const,
          closed_at: now,
        }
      })
      const next: WorkflowState = {
        ...current,
        status: args.taskID || args.sessionID ? current.status : "canceled",
        node_runs: nodeRuns,
        updated_at: now,
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
      writeState(root, next)
      writeCurrent(root, next.id)
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
      }
      writeNodeTask(root, current.id, node.id, args.task_markdown)
      writeReportTask(root, current.id, node.task_id ?? node.id, args.task_markdown)
      writeState(root, next)
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
    reset() {
      const currentPath = join(root, "current.json")
      if (existsSync(currentPath)) rmSync(currentPath)
    },
  }
}

function resumableStatus(status: WorkflowState["status"]): WorkflowState["status"] {
  if (status === "passed" || status === "canceled") return status
  return "running"
}

function createWorkflowState(args: {
  id: string
  project: string
  workflow: WorkflowKind
  entrypoint: WorkflowEntrypoint
  goal: string
  parentSessionID: string
  activation: WorkflowState["activation"]
}): WorkflowState {
  const now = new Date().toISOString()
  const mode = modeForWorkflow(args.workflow, args.entrypoint)
  return {
    id: args.id,
    project: args.project,
    session: args.parentSessionID,
    parent_session_id: args.parentSessionID,
    activation: args.activation,
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
  switch (workflow) {
    case "debug":
      return "debug"
    case "plan-only":
      return "plan"
    case "review":
      return "review"
    case "verify-finish":
      return "verify-finish"
    case "parallel-investigate":
      return "parallel-investigate"
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
  if (args.current.activation === "draft" && args.input.event === "plan" && args.input.status === "passed") {
    return {
      prompt: "Plan and task graph are ready. Review the artifacts, decide whether changes are needed, and confirm before calling sp_start.",
      options: ["start", "revise"],
      source_node_id: args.nodeID,
    }
  }
  return args.next.pending_question
}
