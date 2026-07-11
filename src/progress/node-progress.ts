import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Event } from "@opencode-ai/sdk"
import type { NodeRun, WorkflowState } from "../state/types"

export type NodeProgressKind =
  | "session_status"
  | "session_idle"
  | "session_error"
  | "tool_pending"
  | "tool_running"
  | "tool_completed"
  | "tool_error"
  | "text"
  | "reasoning"
  | "patch"
  | "step"
  | "message"

export type NodeProgressEntry = {
  at: string
  kind: NodeProgressKind
  session_id: string
  node_id: string
  agent: string
  phase: string
  task_id?: string
  summary: string
  detail?: string
}

export type NodeProgressStore = ReturnType<typeof createNodeProgressStore>

export function createNodeProgressStore(project: string) {
  const root = join(project, ".opencode", "superpowers")
  return {
    append(runID: string, entry: NodeProgressEntry): void {
      const path = progressPath(root, runID, entry.node_id)
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify(entry)}\n`)
    },
    readNode(runID: string, nodeID: string): NodeProgressEntry[] {
      const path = progressPath(root, runID, nodeID)
      if (!existsSync(path)) return []
      return readJsonLines(path)
    },
    readRun(state: WorkflowState): Record<string, NodeProgressEntry[]> {
      const result: Record<string, NodeProgressEntry[]> = {}
      for (const node of state.node_runs) {
        result[node.id] = this.readNode(state.id, node.id)
      }
      return result
    },
    recordEvent(state: WorkflowState | null, event: Event, at = new Date().toISOString()): NodeProgressEntry | null {
      if (!state) return null
      const entry = progressEntryFromEvent(state, event, at)
      if (!entry) return null
      this.append(state.id, entry)
      return entry
    },
  }
}

export function progressEntryFromEvent(state: WorkflowState, event: Event, at = new Date().toISOString()): NodeProgressEntry | null {
  const sessionID = sessionIDFromEvent(event)
  if (!sessionID) return null
  const node = state.node_runs.find((run) => run.session_id === sessionID)
  if (!node) return null

  const base = baseEntry(at, node)
  switch (event.type) {
    case "session.status":
      return {
        ...base,
        kind: "session_status",
        summary: sessionStatusSummary(event.properties.status),
      }
    case "session.idle":
      return {
        ...base,
        kind: "session_idle",
        summary: "session idle",
      }
    case "session.error":
      return {
        ...base,
        kind: "session_error",
        summary: `session error: ${errorMessage(event.properties.error)}`,
      }
    case "message.part.updated":
      return entryFromPart(base, event.properties.part, event.properties.delta)
    default:
      return null
  }
}

function baseEntry(at: string, node: NodeRun): Omit<NodeProgressEntry, "kind" | "summary" | "detail"> {
  return {
    at,
    session_id: node.session_id,
    node_id: node.id,
    agent: node.agent,
    phase: node.phase,
    task_id: node.task_id,
  }
}

function sessionIDFromEvent(event: Event): string | undefined {
  switch (event.type) {
    case "session.status":
    case "session.idle":
      return event.properties.sessionID
    case "session.error":
      return event.properties.sessionID
    case "message.part.updated":
      return event.properties.part.sessionID
    default:
      return undefined
  }
}

function entryFromPart(
  base: Omit<NodeProgressEntry, "kind" | "summary" | "detail">,
  part: Extract<Event, { type: "message.part.updated" }>["properties"]["part"],
  delta?: string,
): NodeProgressEntry {
  switch (part.type) {
    case "tool":
      return entryFromToolPart(base, part)
    case "text":
      return {
        ...base,
        kind: "text",
        summary: "assistant text updated",
        detail: truncate(delta ?? part.text),
      }
    case "reasoning":
      return {
        ...base,
        kind: "reasoning",
        summary: "reasoning updated",
        detail: truncate(delta ?? part.text),
      }
    case "patch":
      return {
        ...base,
        kind: "patch",
        summary: `patch updated: ${part.files.length} file${part.files.length === 1 ? "" : "s"}`,
        detail: part.files.join(", "),
      }
    case "step-start":
      return {
        ...base,
        kind: "step",
        summary: "step started",
      }
    case "step-finish":
      return {
        ...base,
        kind: "step",
        summary: `step finished: ${part.reason}`,
      }
    default:
      return {
        ...base,
        kind: "message",
        summary: `${part.type} updated`,
      }
  }
}

function entryFromToolPart(
  base: Omit<NodeProgressEntry, "kind" | "summary" | "detail">,
  part: Extract<Extract<Event, { type: "message.part.updated" }>["properties"]["part"], { type: "tool" }>,
): NodeProgressEntry {
  switch (part.state.status) {
    case "pending":
      return {
        ...base,
        kind: "tool_pending",
        summary: `${part.tool} pending`,
        detail: truncate(JSON.stringify(part.state.input)),
      }
    case "running":
      return {
        ...base,
        kind: "tool_running",
        summary: runningToolSummary(part.tool, part.state.title),
        detail: toolInputDetail(part.state.input, part.state.title),
      }
    case "completed":
      return {
        ...base,
        kind: "tool_completed",
        summary: `${part.tool} completed`,
        detail: truncate(part.state.title || part.state.output),
      }
    case "error":
      return {
        ...base,
        kind: "tool_error",
        summary: `${part.tool} error`,
        detail: truncate(part.state.error),
      }
  }
}

function sessionStatusSummary(status: Extract<Event, { type: "session.status" }>["properties"]["status"]): string {
  if (status.type === "retry") return `session retry ${status.attempt}: ${status.message}`
  return `session ${status.type}`
}

function errorMessage(error: Extract<Event, { type: "session.error" }>["properties"]["error"]): string {
  if (!error) return "unknown error"
  if ("data" in error && typeof error.data === "object" && error.data !== null) {
    const message = (error.data as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  return error.name
}

function toolInputDetail(input: Record<string, unknown>, title?: string): string | undefined {
  if (title?.trim()) return truncate(title.trim())
  const command = input.cmd ?? input.command ?? input.filePath ?? input.path
  if (typeof command === "string") return truncate(command)
  return truncate(JSON.stringify(input))
}

function runningToolSummary(tool: string, title?: string): string {
  if (title?.trim()) return `↳ ${titlecase(tool)} ${title.trim()}`
  return `${tool} running`
}

function titlecase(value: string): string {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function progressPath(root: string, runID: string, nodeID: string): string {
  return join(root, "runs", runID, "nodes", nodeID, "progress.jsonl")
}

function readJsonLines(path: string): NodeProgressEntry[] {
  const body = readFileSync(path, "utf8")
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NodeProgressEntry)
}

function truncate(value: string | undefined, max = 240): string | undefined {
  if (!value) return undefined
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}
