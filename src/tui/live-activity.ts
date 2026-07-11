export type ChildLiveActivity = {
  summary: string
  detail?: string
  tool_count: number
  current_tool?: string
  observed_at?: string
}

export type SessionMessageReader = {
  messages?(sessionID: string): ReadonlyArray<unknown>
  part?(messageID: string): ReadonlyArray<unknown>
}

export function liveActivityBySession(
  reader: SessionMessageReader,
  sessionIDs: string[],
): Record<string, ChildLiveActivity> {
  const result: Record<string, ChildLiveActivity> = {}
  for (const sessionID of sessionIDs) {
    const activity = extractChildLiveActivity(reader, sessionID)
    if (activity) result[sessionID] = activity
  }
  return result
}

export function extractChildLiveActivity(
  reader: SessionMessageReader,
  sessionID: string,
): ChildLiveActivity | null {
  const messages = reader.messages?.(sessionID) ?? []
  if (messages.length === 0) return null

  const tools = collectToolParts(reader, messages)
  if (tools.length === 0) return null

  const running = tools.some((tool) => tool.status === "running" || tool.status === "pending")
  const current = running ? currentRunningTool(tools) : tools.at(-1)
  const summary = running
    ? formatRunningActivity(tools, current)
    : formatCompletedActivity(tools)

  return {
    summary,
    detail: current?.detail,
    tool_count: tools.length,
    current_tool: current?.label,
    observed_at: current?.at,
  }
}

type ToolActivity = {
  tool: string
  status: string
  title?: string
  detail?: string
  label: string
  at?: string
}

function collectToolParts(reader: SessionMessageReader, messages: ReadonlyArray<unknown>): ToolActivity[] {
  const tools: ToolActivity[] = []
  for (const message of messages) {
    const parts = messageParts(reader, message)
    for (const part of parts) {
      const activity = toolActivityFromPart(part)
      if (activity) tools.push(activity)
    }
  }
  return tools
}

function messageParts(reader: SessionMessageReader, message: unknown): ReadonlyArray<unknown> {
  if (!isRecord(message)) return []
  if (Array.isArray(message.parts)) return message.parts
  const info = isRecord(message.info) ? message.info : message
  const messageID = typeof info.id === "string" ? info.id : undefined
  if (!messageID || !reader.part) return []
  return reader.part(messageID)
}

function toolActivityFromPart(part: unknown): ToolActivity | null {
  if (!isRecord(part) || part.type !== "tool") return null
  const tool = typeof part.tool === "string" ? part.tool : "tool"
  const state = isRecord(part.state) ? part.state : {}
  const status = typeof state.status === "string" ? state.status : "unknown"
  const title = typeof state.title === "string" && state.title.trim() ? state.title.trim() : undefined
  const detail = toolDetail(state, title)
  const label = title ? `${titlecase(tool)} ${title}` : titlecase(tool)
  const at = messageTime(part, state)
  return { tool, status, title, detail, label, at }
}

function currentRunningTool(tools: ToolActivity[]): ToolActivity | undefined {
  const active = tools.filter((tool) => tool.status === "running" || tool.status === "pending")
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const tool = active[index]
    if (tool?.title) return tool
  }
  return active.at(-1)
}

function formatRunningActivity(tools: ToolActivity[], current: ToolActivity | undefined): string {
  if (current?.title) return `↳ ${current.label}`
  const activeCount = tools.filter((tool) => tool.status === "running" || tool.status === "pending").length
  const count = activeCount > 0 ? activeCount : tools.length
  if (count > 0) return `↳ ${count} toolcall${count === 1 ? "" : "s"}`
  return "↳ working"
}

function formatCompletedActivity(tools: ToolActivity[]): string {
  const last = tools.at(-1)
  if (last?.title) return `└ ${tools.length} toolcall${tools.length === 1 ? "" : "s"} · ${last.label}`
  return `└ ${tools.length} toolcall${tools.length === 1 ? "" : "s"}`
}

function toolDetail(state: Record<string, unknown>, title?: string): string | undefined {
  if (title) return title
  const input = isRecord(state.input) ? state.input : {}
  const command = input.cmd ?? input.command ?? input.filePath ?? input.path
  if (typeof command === "string" && command.trim()) return command.trim()
  const output = typeof state.output === "string" ? state.output : undefined
  if (output?.trim()) return truncate(output.trim())
  return undefined
}

function messageTime(part: Record<string, unknown>, state: Record<string, unknown>): string | undefined {
  const candidates = [part.time, state.time, state.startedAt, state.completedAt]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return new Date(candidate).toISOString()
    }
  }
  return undefined
}

function titlecase(value: string): string {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function truncate(value: string, max = 96): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
