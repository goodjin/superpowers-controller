import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { applyRecord, createInitialState } from "./transitions"
import { normalizeTaskGraph } from "./task-graph"
import type { NodeRun, WorkflowEntrypoint, WorkflowKind, WorkflowMode, WorkflowRecord, WorkflowState } from "./types"

export type ProjectStore = {
  root: string
  readCurrent(): WorkflowState | null
  start(args: { session: string; mode: WorkflowMode; goal: string }): WorkflowState
  startRun(args: {
    workflow: WorkflowKind
    entrypoint: WorkflowEntrypoint
    goal: string
    request: string
    proposal: string
    parentSessionID: string
  }): WorkflowState
  record(record: WorkflowRecord): WorkflowState
  recordNodeResult(args: { nodeID?: string; input: WorkflowRecord }): WorkflowState
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
      const statePath = join(root, "runs", pointer.run, "state.json")
      if (!existsSync(statePath)) return null
      return JSON.parse(readFileSync(statePath, "utf8")) as WorkflowState
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
      })
      const runRoot = join(root, "runs", state.id)
      mkdirSync(join(runRoot, "artifacts"), { recursive: true })
      mkdirSync(join(runRoot, "nodes"), { recursive: true })
      writeState(root, state)
      writeCurrent(root, state.id)
      writeRunMarkdown(root, state.id, "request.md", args.request)
      writeRunMarkdown(root, state.id, "proposal.md", args.proposal)
      appendChangelog(root, state.id, `created ${args.workflow} workflow from ${args.entrypoint}`)
      return state
    },
    record(record) {
      const current = this.readCurrent()
      if (!current) {
        throw new Error("No active Superpowers workflow. Call sp_route or sp_next first.")
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
      if (args.input.task_graph) {
        const normalized = normalizeTaskGraph(args.input.task_graph)
        writeJson(root, current.id, "task_graph.json", normalized)
      }
      const next = applyRecord(current, args.input)
      const nodeRuns = completeNodeRuns(next.node_runs, nodeID, args.input)
      const withNodes = {
        ...next,
        node_runs: nodeRuns,
        pending_question:
          args.input.status === "needs_user" && args.input.question
            ? { ...args.input.question, source_node_id: nodeID }
            : next.pending_question,
      }
      writeState(root, withNodes)
      writeCurrent(root, withNodes.id)
      appendChangelog(root, withNodes.id, `${args.input.event}: ${args.input.status} - ${args.input.summary}`)
      return withNodes
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
        node_runs: [...current.node_runs, node],
        updated_at: new Date().toISOString(),
      }
      writeNodeTask(root, current.id, node.id, args.task_markdown)
      writeState(root, next)
      appendChangelog(root, current.id, `dispatch ${node.agent} ${node.task_id ?? node.phase} to ${node.session_id}`)
      return node
    },
    reset() {
      const currentPath = join(root, "current.json")
      if (existsSync(currentPath)) rmSync(currentPath)
    },
  }
}

function createWorkflowState(args: {
  id: string
  project: string
  workflow: WorkflowKind
  entrypoint: WorkflowEntrypoint
  goal: string
  parentSessionID: string
}): WorkflowState {
  const now = new Date().toISOString()
  const mode = modeForWorkflow(args.workflow, args.entrypoint)
  return {
    id: args.id,
    project: args.project,
    session: args.parentSessionID,
    parent_session_id: args.parentSessionID,
    workflow: args.workflow,
    entrypoint: args.entrypoint,
    limited_context: args.entrypoint !== args.workflow,
    mode,
    phase: "intake",
    current_phase: "intake",
    status: "intake",
    goal: args.goal,
    created_at: now,
    updated_at: now,
    gates: {},
    artifacts: {},
    node_runs: [],
    history: [{ at: now, event: "created", to: args.workflow }],
  }
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

function appendChangelog(root: string, run: string, message: string): void {
  const path = join(root, "runs", run, "changelog.md")
  mkdirSync(dirname(path), { recursive: true })
  const current = existsSync(path) ? readFileSync(path, "utf8") : "# Changelog\n\n"
  writeFileSync(path, `${current.trimEnd()}\n- ${new Date().toISOString()} ${message}\n`)
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
  const endedAt = new Date().toISOString()
  return nodeRuns.map((run) => {
    if (run.id !== nodeID) return run
    return {
      ...run,
      status: record.status,
      ended_at: endedAt,
      record_path: `nodes/${nodeID}/record.json`,
    }
  })
}
