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

export function normalizeSessionLiveStatus(status: string | undefined): string {
  if (!status) return "unknown"
  if (status === "running") return "busy"
  return status
}

export function isActiveHostSessionStatus(status: string | undefined): boolean {
  const normalized = normalizeSessionLiveStatus(status)
  return normalized === "busy" || normalized === "retry" || normalized === "waiting_permission"
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

export type SessionCurrentAction = {
  kind: "thinking" | "tool" | "waiting_permission" | "retry" | "idle" | "unknown"
  label: string
}

export function extractSessionCurrentAction(
  reader: SessionMessageReader,
  sessionID: string,
  liveStatus?: string,
): SessionCurrentAction | null {
  const normalizedStatus = normalizeSessionLiveStatus(liveStatus)
  if (normalizedStatus === "waiting_permission") {
    return { kind: "waiting_permission", label: "waiting permission" }
  }
  if (normalizedStatus === "retry") {
    return { kind: "retry", label: "retrying" }
  }
  const toolActivity = extractChildLiveActivity(reader, sessionID)
  if (toolActivity?.summary) {
    return { kind: "tool", label: toolActivity.summary }
  }
  if (toolActivity?.current_tool) {
    return { kind: "tool", label: `last ${toolActivity.current_tool}` }
  }
  if (normalizedStatus === "idle") return null

  const parts = latestAssistantParts(reader, sessionID)
  if (hasActiveThinking(parts)) {
    return { kind: "thinking", label: "thinking" }
  }

  if (normalizedStatus === "busy") {
    return { kind: "thinking", label: "thinking" }
  }
  return null
}

export function extractLatestAssistantSnippet(
  reader: SessionMessageReader,
  sessionID: string,
): string | undefined {
  const messages = reader.messages?.(sessionID) ?? []
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = messageParts(reader, messages[messageIndex])
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex]
      if (!isRecord(part)) continue
      if (part.type === "tool") {
        const activity = toolActivityFromPart(part)
        if (!activity) continue
        if (activity.status === "running" || activity.status === "pending") return `calling ${activity.label}`
        return `last ${activity.label}`
      }
      if (part.type === "text" && typeof part.text === "string") {
        const text = part.text.replace(/\s+/g, " ").trim()
        if (text) return truncate(text, 96)
      }
      if (part.type === "reasoning" && typeof part.text === "string") {
        const text = part.text.replace(/\s+/g, " ").trim()
        if (text) return truncate(`thinking: ${text}`, 96)
      }
      if (part.type === "thinking" && typeof part.thinking === "string") {
        const text = part.thinking.replace(/\s+/g, " ").trim()
        if (text) return truncate(`thinking: ${text}`, 96)
      }
    }
  }
  return undefined
}

export function formatSidebarSessionActivity(
  reader: SessionMessageReader,
  row: { id: string; live_status: string; active: boolean },
): string {
  const liveStatus = normalizeSessionLiveStatus(row.live_status)
  const action = extractSessionCurrentAction(reader, row.id, liveStatus)
  if (action?.kind === "tool") return action.label
  if (action?.kind === "thinking") return "thinking…"
  if (action?.kind === "waiting_permission") return "waiting permission"
  if (action?.kind === "retry") return "retrying…"

  const snippet = extractLatestAssistantSnippet(reader, row.id)
  if (snippet) return snippet

  if (row.active || liveStatus === "busy") return "working…"
  if (!row.live_status || liveStatus === "unknown") return "idle"
  return liveStatus
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
  if (Array.isArray(message.content)) return message.content
  const info = isRecord(message.info) ? message.info : message
  const messageID = typeof info.id === "string" ? info.id : undefined
  if (!messageID || !reader.part) return []
  return reader.part(messageID)
}

function messageRole(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined
  if (typeof message.role === "string") return message.role
  const info = isRecord(message.info) ? message.info : message
  return typeof info.role === "string" ? info.role : undefined
}

function toolActivityFromPart(part: unknown): ToolActivity | null {
  if (!isRecord(part)) return null
  if (part.type === "tool-call" || part.type === "tool_call") {
    const tool = typeof part.name === "string" ? part.name : typeof part.tool === "string" ? part.tool : "tool"
    const status = typeof part.status === "string" ? part.status : "running"
    const title = typeof part.title === "string" && part.title.trim() ? part.title.trim() : undefined
    const label = formatToolLabel(tool, title)
    return { tool, status, title, label }
  }
  if (part.type !== "tool") return null
  const tool = typeof part.tool === "string" ? part.tool : "tool"
  const state = isRecord(part.state) ? part.state : {}
  const status = typeof state.status === "string" ? state.status : "unknown"
  const title = typeof state.title === "string" && state.title.trim()
    ? state.title.trim()
    : typeof state.metadata === "object" && state.metadata && typeof (state.metadata as Record<string, unknown>).title === "string"
      ? String((state.metadata as Record<string, unknown>).title).trim()
      : undefined
  const detail = toolDetail(state, title)
  const label = formatToolLabel(tool, title)
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
  if (current?.title) return `calling ${current.label}`
  const activeCount = tools.filter((tool) => tool.status === "running" || tool.status === "pending").length
  const count = activeCount > 0 ? activeCount : tools.length
  if (count > 0) return `calling ${count} toolcall${count === 1 ? "" : "s"}`
  return "working…"
}

function formatCompletedActivity(tools: ToolActivity[]): string {
  const last = tools.at(-1)
  if (last) return `last ${last.label}`
  return `last ${tools.length} toolcall${tools.length === 1 ? "" : "s"}`
}

function formatToolLabel(tool: string, title?: string): string {
  if (title) return `${titlecase(tool)} ${title}`
  return titlecase(tool)
}

function latestAssistantParts(reader: SessionMessageReader, sessionID: string): ReadonlyArray<unknown> {
  const messages = reader.messages?.(sessionID) ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message)) continue
    const role = messageRole(message)
    if (role && role !== "assistant") continue
    const parts = messageParts(reader, message)
    if (parts.length > 0) return parts
  }
  return []
}

function hasActiveThinking(parts: ReadonlyArray<unknown>): boolean {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (!isRecord(part)) continue
    if (part.type === "step-finish") return false
    if (part.type === "tool" && isRecord(part.state)) {
      const status = typeof part.state.status === "string" ? part.state.status : ""
      if (status === "running" || status === "pending") return false
    }
    if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim()) return true
    if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) return true
    if (part.type === "step-start") return true
  }
  return false
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
