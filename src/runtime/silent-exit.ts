import type { NodeProgressEntry } from "../progress/node-progress"

export type SilentExitReason = "session_idle" | "liveness_timeout" | "session_error"

export type SilentExitEvidence = {
  reason: SilentExitReason
  assistant_text: string
  produced_paths: string[]
  summary: string
  error?: string
  idle_ms?: number
  collected_at: string
}

const CONTROLLER_PROMPT_PREFIXES = [
  "# Superpowers workflow waiting for user input",
  "# Superpowers User Input Resume",
  "# Superpowers Node Task:",
  "# Superpowers workflow waiting for controller decision",
]

const PATH_KEYS = [
  "filePath",
  "filepath",
  "file_path",
  "path",
  "file",
  "target",
  "targetPath",
  "destination",
  "output",
  "outputPath",
] as const

export function collectSilentExitEvidence(args: {
  reason: SilentExitReason
  messages?: ReadonlyArray<unknown>
  progress?: ReadonlyArray<NodeProgressEntry>
  error?: unknown
  idle_ms?: number
  now?: Date
}): SilentExitEvidence {
  const collected_at = (args.now ?? new Date()).toISOString()
  const assistant_text = extractLastAssistantText(args.messages ?? [])
  const fromMessages = collectPathsFromMessages(args.messages ?? [])
  const fromProgress = collectPathsFromProgress(args.progress ?? [])
  const produced_paths = uniquePaths([...fromMessages, ...fromProgress])
  const error = args.error !== undefined ? errorMessage(args.error) : undefined
  const summary = buildSummary({
    reason: args.reason,
    assistant_text,
    produced_paths,
    error,
    idle_ms: args.idle_ms,
  })
  return {
    reason: args.reason,
    assistant_text,
    produced_paths,
    summary,
    error,
    idle_ms: args.idle_ms,
    collected_at,
  }
}

export function formatSilentExitMarkdown(args: {
  node_id: string
  session_id: string
  agent: string
  phase: string
  task_id?: string
  evidence: SilentExitEvidence
}): string {
  const { evidence } = args
  const paths = evidence.produced_paths.length
    ? evidence.produced_paths.map((path) => `- ${path}`).join("\n")
    : "- (none detected)"
  const text = evidence.assistant_text.trim() || "(no assistant text captured)"
  return [
    "# Silent Exit Capture",
    "",
    `Node: ${args.node_id}`,
    `Session: ${args.session_id}`,
    `Agent: ${args.agent}`,
    `Phase: ${args.phase}`,
    args.task_id ? `Task: ${args.task_id}` : "",
    `Reason: ${evidence.reason}`,
    evidence.idle_ms !== undefined ? `Idle ms: ${evidence.idle_ms}` : "",
    evidence.error ? `Error: ${evidence.error}` : "",
    `Collected at: ${evidence.collected_at}`,
    "",
    "## Summary",
    "",
    evidence.summary,
    "",
    "## Produced Paths",
    "",
    paths,
    "",
    "## Last Assistant Text",
    "",
    text,
    "",
  ].filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n")
}

export function extractLastAssistantText(messages: ReadonlyArray<unknown>, maxChars = 50_000): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message)) continue
    const role = messageRole(message)
    if (role && role !== "assistant") continue
    const parts = messageParts(message)
    const chunks: string[] = []
    for (const part of parts) {
      if (!isRecord(part)) continue
      if (part.type !== "text" || typeof part.text !== "string") continue
      const text = part.text.trim()
      if (!text || looksLikeControllerPrompt(text)) continue
      chunks.push(text)
    }
    if (chunks.length === 0) continue
    const joined = chunks.join("\n\n").trim()
    if (!joined) continue
    return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n\n…(truncated)` : joined
  }
  return ""
}

export function collectPathsFromMessages(messages: ReadonlyArray<unknown>): string[] {
  const paths: string[] = []
  for (const message of messages) {
    for (const part of messageParts(message)) {
      if (!isRecord(part)) continue
      if (part.type === "patch") {
        collectPathCandidate(paths, part.path)
        collectPathCandidate(paths, part.file)
        collectPathCandidate(paths, part.filepath)
        if (Array.isArray(part.files)) {
          for (const file of part.files) collectPathCandidate(paths, file)
        }
        continue
      }
      if (part.type !== "tool" && part.type !== "tool-call" && part.type !== "tool_call") continue
      const state = isRecord(part.state) ? part.state : {}
      const input = isRecord(state.input) ? state.input : isRecord(part.input) ? part.input : {}
      for (const key of PATH_KEYS) collectPathCandidate(paths, input[key])
      if (Array.isArray(input.files)) {
        for (const file of input.files) collectPathCandidate(paths, file)
      }
      if (Array.isArray(input.edits)) {
        for (const edit of input.edits) {
          if (isRecord(edit)) {
            for (const key of PATH_KEYS) collectPathCandidate(paths, edit[key])
          }
        }
      }
      const metadata = isRecord(state.metadata) ? state.metadata : {}
      for (const key of PATH_KEYS) collectPathCandidate(paths, metadata[key])
      collectPathCandidate(paths, state.title)
      collectPathCandidate(paths, part.title)
    }
  }
  return paths
}

export function collectPathsFromProgress(progress: ReadonlyArray<NodeProgressEntry>): string[] {
  const paths: string[] = []
  for (const entry of progress) {
    if (entry.kind === "patch" || entry.kind === "tool_completed" || entry.kind === "tool_running") {
      collectPathCandidate(paths, entry.detail)
    }
  }
  return paths
}

function buildSummary(args: {
  reason: SilentExitReason
  assistant_text: string
  produced_paths: string[]
  error?: string
  idle_ms?: number
}): string {
  const bits = [`Child session ended without sp_report (${args.reason}).`]
  if (args.idle_ms !== undefined) bits.push(`Idle ${args.idle_ms}ms.`)
  if (args.error) bits.push(`Error: ${args.error}`)
  if (args.produced_paths.length) bits.push(`Produced paths: ${args.produced_paths.slice(0, 8).join(", ")}.`)
  if (args.assistant_text.trim()) {
    const snippet = args.assistant_text.replace(/\s+/g, " ").trim()
    bits.push(`Last assistant text: ${snippet.length > 240 ? `${snippet.slice(0, 237)}...` : snippet}`)
  } else {
    bits.push("No assistant text captured.")
  }
  return bits.join(" ")
}

function looksLikeControllerPrompt(text: string): boolean {
  return CONTROLLER_PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix))
}

function messageRole(message: Record<string, unknown>): string | undefined {
  if (typeof message.role === "string") return message.role
  const info = isRecord(message.info) ? message.info : message
  return typeof info.role === "string" ? info.role : undefined
}

function messageParts(message: unknown): ReadonlyArray<unknown> {
  if (!isRecord(message)) return []
  if (Array.isArray(message.parts)) return message.parts
  if (Array.isArray(message.content)) return message.content
  return []
}

function collectPathCandidate(out: string[], value: unknown): void {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 500) return
  if (trimmed.includes("\n") || trimmed.includes("\0")) return
  // Absolute paths, workspace-relative paths, or repo-looking paths with an extension / known dir.
  const looksLikePath =
    trimmed.startsWith("/")
    || trimmed.startsWith("./")
    || trimmed.startsWith("../")
    || /^[A-Za-z]:[\\/]/.test(trimmed)
    || /\.(md|ts|tsx|js|jsx|json|jsonc|dart|swift|py|go|rs|toml|yml|yaml|css|html|sh)$/i.test(trimmed)
    || /^(docs|src|app|test|reports|artifacts|nodes)\//.test(trimmed)
  if (!looksLikePath) return
  // Drop command lines that merely contain a path-like token amid spaces / flags.
  if (/\s--|^\s*(cd|ls|git|npm|bun|flutter|cat|rg|grep)\b/i.test(trimmed) && trimmed.includes(" ")) return
  out.push(trimmed)
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    result.push(path)
  }
  return result
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
