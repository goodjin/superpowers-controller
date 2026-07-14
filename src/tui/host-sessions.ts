import {
  extractLatestAssistantSnippet,
  formatSidebarSessionActivity,
  isActiveHostSessionStatus,
  normalizeSessionLiveStatus,
} from "./live-activity"

export type HostSessionApi = {
  state: {
    path: { directory: string; worktree?: string }
    session: {
      count?: () => number
      get?: (sessionID: string) => HostSessionRecord | undefined
      status: (sessionID: string) => { type: string; attempt?: number; message?: string } | undefined
    }
  }
  client?: {
    session?: {
      list?: () => Promise<unknown>
    }
  }
}

export type HostSessionSeed = {
  state: {
    parent_session_id?: string
    session?: string
    node_runs: Array<{ session_id: string }>
  }
}

export type HostSessionRecord = {
  id: string
  title?: string
  agent?: string
  parentID?: string
  directory?: string
  time?: { updated?: number; created?: number }
}

export type HostSessionRow = {
  id: string
  title: string
  agent: string
  parent_id?: string
  live_status: string
  active: boolean
  updated_at: number
}

export type SidebarHostRenderMode = "single-focus" | "overview" | "workflow-list"

export type HostSessionSidebarReader = HostSessionApi & {
  state: HostSessionApi["state"] & {
    session: HostSessionApi["state"]["session"] & {
      messages?(sessionID: string): ReadonlyArray<unknown>
    }
  }
  part?(messageID: string): ReadonlyArray<unknown>
}

export {
  isActiveHostSessionStatus,
  normalizeSessionLiveStatus,
} from "./live-activity"

export function collectWorkflowSessionIDs(
  state: HostSessionSeed["state"] | null | undefined,
  currentSessionID?: string,
): string[] {
  const ids = new Set<string>()
  if (typeof currentSessionID === "string") ids.add(currentSessionID)
  if (!state) return [...ids]
  if (state.parent_session_id) ids.add(state.parent_session_id)
  if (state.session) ids.add(state.session)
  for (const node of state.node_runs) ids.add(node.session_id)
  return [...ids]
}

/** @deprecated Prefer collectWorkflowSessionIDs for sidebar surfaces. */
export function collectSeedSessionIDs(
  candidates: HostSessionSeed[],
  currentSessionID?: string,
): string[] {
  const ids = new Set<string>()
  if (typeof currentSessionID === "string") ids.add(currentSessionID)
  for (const candidate of candidates) {
    if (candidate.state.parent_session_id) ids.add(candidate.state.parent_session_id)
    if (candidate.state.session) ids.add(candidate.state.session)
    for (const node of candidate.state.node_runs) ids.add(node.session_id)
  }
  return [...ids]
}

export function readHostSessionsSync(
  api: HostSessionApi,
  seedIDs: string[] = [],
): HostSessionRow[] {
  const rows = readHostSessionsFromState(api, seedIDs)
  if (rows.length > 0) return sortHostSessions(rows)

  const total = api.state.session.count?.()
  if (typeof total === "number" && total > 0) {
    return [{
      id: "summary",
      title: `${total} session${total === 1 ? "" : "s"} in project`,
      agent: "opencode",
      live_status: "unavailable",
      active: false,
      updated_at: 0,
    }]
  }
  return []
}

export async function loadHostSessions(
  api: HostSessionApi,
  directory: string,
  seedIDs: string[] = [],
): Promise<HostSessionRow[]> {
  const listed = await listHostSessionsFromClient(api, directory)
  if (listed.length > 0) return sortHostSessions(listed)
  return readHostSessionsSync(api, seedIDs)
}

export function resolveSidebarHostRenderMode(
  hasWorkflow: boolean,
  rows: HostSessionRow[],
): SidebarHostRenderMode {
  if (hasWorkflow) return "workflow-list"
  const active = rows.filter((row) => row.active)
  if (active.length === 1) return "single-focus"
  if (active.length === 0 && rows.length === 1) return "single-focus"
  return "overview"
}

export function renderSidebarHostSection(
  api: HostSessionSidebarReader,
  rows: HostSessionRow[],
  mode: SidebarHostRenderMode,
  maxOverviewRows = 8,
): string {
  switch (mode) {
    case "single-focus": {
      const active = rows.find((row) => row.active)
      return active ? renderSingleSessionFocus(api, active) : renderHostSessionsOverview(rows, maxOverviewRows)
    }
    case "workflow-list":
      return renderWorkflowSessionsList(rows)
    default:
      return renderHostSessionsOverview(rows, maxOverviewRows)
  }
}

export function renderSingleSessionFocus(
  api: HostSessionSidebarReader,
  row: HostSessionRow,
): string {
  const reader = sessionMessageReader(api)
  const title = truncateLine(row.title || row.id, 56)
  const activity = formatSidebarSessionActivity(reader, row)
  const lines = [`${title} — ${activity}`]
  const recent = extractLatestAssistantSnippet(reader, row.id)
  if (recent && recent !== activity && !activity.includes(recent.slice(0, 24))) {
    lines.push(truncateLine(recent, 96))
  }
  return lines.join("\n")
}

export function renderWorkflowSessionsList(rows: HostSessionRow[]): string {
  if (rows.length === 0) return "Sessions\nnone"
  if (rows.length === 1 && rows[0]?.id === "summary") {
    return ["Sessions", rows[0].title, "session list unavailable in this host build"].join("\n")
  }

  const sorted = sortHostSessions(rows)
  const running = sorted.filter((row) => row.active).length
  const lines = [
    "Sessions",
    `total ${sorted.length} | running ${running}`,
  ]
  for (const row of sorted) {
    const marker = row.active ? "●" : " "
    const parent = row.parent_id ? " child" : ""
    lines.push(`${marker} ${row.agent}${parent}: ${row.live_status} - ${truncateLine(row.title || row.id, 72)}`)
  }
  return lines.join("\n")
}

export function renderHostSessionsOverview(rows: HostSessionRow[], maxRows = 8): string {
  if (rows.length === 0) return "OpenCode sessions\nnone"
  if (rows.length === 1 && rows[0]?.id === "summary") {
    return ["OpenCode sessions", rows[0].title, "session list unavailable in this host build"].join("\n")
  }

  const total = rows.length
  const running = rows.filter((row) => row.active).length
  const lines = [
    "OpenCode sessions",
    `total ${total} | running ${running}`,
  ]
  const visible = sortHostSessions(rows).slice(0, maxRows)
  for (const [index, row] of visible.entries()) {
    const marker = index === 0 ? ">" : " "
    const shortcut = index < 9 ? `[⌘${index + 1}] ` : ""
    const parent = row.parent_id ? " child" : ""
    lines.push(`${marker} ${shortcut}${row.agent}${parent}: ${row.live_status} - ${truncateLine(row.title || row.id, 72)}`)
  }
  if (rows.length > maxRows) lines.push(`+${rows.length - maxRows} more`)
  return lines.join("\n")
}

export function combineSidebarContentText(parts: {
  hostOverview: string
  workflowText: string
  hasWorkflow: boolean
  hostMode?: SidebarHostRenderMode
}): string {
  const sections: string[] = []
  if (parts.workflowText) sections.push(parts.workflowText)
  else if (parts.hasWorkflow) sections.push("SP: workflow active")
  else if (parts.hostMode !== "single-focus") sections.push("Superpowers workflow\nnot started")
  if (parts.hostOverview) sections.push(parts.hostOverview)
  const combined = sections.join("\n\n").trim()
  if (combined) return combined
  return parts.hostMode === "single-focus" ? "Session running" : "Superpowers sidebar\nwaiting for session state"
}

function sessionMessageReader(api: HostSessionSidebarReader): import("./live-activity").SessionMessageReader {
  return {
    messages: api.state.session.messages?.bind(api.state.session),
    part: api.part?.bind(api),
  }
}

const HOST_SESSION_LIST_TIMEOUT_MS = 2_000
const MAX_LISTED_HOST_SESSIONS = 32

async function listHostSessionsFromClient(api: HostSessionApi, directory: string): Promise<HostSessionRow[]> {
  const list = api.client?.session?.list
  if (!list) return []
  try {
    const response = await Promise.race([
      list(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("session list timeout")), HOST_SESSION_LIST_TIMEOUT_MS)
      }),
    ])
    const sessions = normalizeSessionList(response)
    const filtered = sessions
      .filter((session) => !session.directory || session.directory === directory)
      .sort((left, right) => (right.time?.updated ?? right.time?.created ?? 0) - (left.time?.updated ?? left.time?.created ?? 0))
      .slice(0, MAX_LISTED_HOST_SESSIONS)
    return filtered.map((session) => toHostSessionRow(api, session))
  } catch {
    return []
  }
}

function readHostSessionsFromState(api: HostSessionApi, seedIDs: string[]): HostSessionRow[] {
  const get = api.state.session.get
  if (!get) {
    return seedIDs.map((sessionID) => toHostSessionRow(api, { id: sessionID }))
  }
  return seedIDs
    .map((sessionID) => get(sessionID))
    .filter((session): session is HostSessionRecord => Boolean(session?.id))
    .map((session) => toHostSessionRow(api, session))
}

function readHostSessionStatus(api: HostSessionApi, sessionID: string): string {
  try {
    return normalizeSessionLiveStatus(formatHostSessionStatus(api.state.session.status(sessionID)))
  } catch {
    return "unknown"
  }
}

function toHostSessionRow(api: HostSessionApi, session: HostSessionRecord): HostSessionRow {
  const liveStatus = readHostSessionStatus(api, session.id)
  return {
    id: session.id,
    title: session.title?.trim() || session.id,
    agent: session.agent?.trim() || "session",
    parent_id: session.parentID,
    live_status: liveStatus,
    active: isActiveHostSessionStatus(liveStatus),
    updated_at: session.time?.updated ?? session.time?.created ?? 0,
  }
}

function sortHostSessions(rows: HostSessionRow[]): HostSessionRow[] {
  return [...rows].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1
    return right.updated_at - left.updated_at
  })
}

function normalizeSessionList(response: unknown): HostSessionRecord[] {
  const payload = unwrapListPayload(response)
  if (!Array.isArray(payload)) return []
  return payload
    .map((entry) => normalizeSessionRecord(entry))
    .filter((entry): entry is HostSessionRecord => Boolean(entry?.id))
}

function unwrapListPayload(response: unknown): unknown[] | null {
  if (Array.isArray(response)) return response
  if (!isRecord(response)) return null
  if (Array.isArray(response.data)) return response.data
  if (isRecord(response.data) && Array.isArray(response.data.sessions)) return response.data.sessions
  return null
}

function normalizeSessionRecord(value: unknown): HostSessionRecord | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === "string" ? value.id : undefined
  if (!id) return null
  const time = isRecord(value.time)
    ? {
      updated: typeof value.time.updated === "number" ? value.time.updated : undefined,
      created: typeof value.time.created === "number" ? value.time.created : undefined,
    }
    : undefined
  return {
    id,
    title: typeof value.title === "string" ? value.title : undefined,
    agent: typeof value.agent === "string" ? value.agent : undefined,
    parentID: typeof value.parentID === "string" ? value.parentID : undefined,
    directory: typeof value.directory === "string" ? value.directory : undefined,
    time,
  }
}

function formatHostSessionStatus(status: { type: string; attempt?: number; message?: string } | undefined): string {
  if (!status) return "unknown"
  if (status.type === "retry") return `retry ${status.attempt ?? "?"}${status.message ? `: ${status.message}` : ""}`
  return status.type
}

function truncateLine(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
