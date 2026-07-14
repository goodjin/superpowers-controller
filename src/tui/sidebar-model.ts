import {
  formatSidebarSessionActivity,
  extractLatestAssistantSnippet,
} from "./live-activity"
import type {
  HostSessionRow,
  HostSessionSidebarReader,
  SidebarHostRenderMode,
} from "./host-sessions"

export type SidebarSessionRow = {
  marker: string
  shortcut: string
  agent: string
  parentSuffix: string
  status: string
  title: string
  activity?: string
  active: boolean
}

export type SidebarHostModel =
  | {
    kind: "single-focus"
    title: string
    activity: string
    detail?: string
  }
  | {
    kind: "session-list"
    heading: string
    summary: string
    rows: SidebarSessionRow[]
    moreCount?: number
  }
  | {
    kind: "message"
    lines: string[]
  }

export type SidebarViewModel = {
  hasWorkflow: boolean
  hostMode: SidebarHostRenderMode
  workflowLines: string[]
  workflowDiagnostic?: string
  host: SidebarHostModel
  placeholder?: string
}

export function buildSidebarHostModel(
  api: HostSessionSidebarReader,
  rows: HostSessionRow[],
  mode: SidebarHostRenderMode,
  maxOverviewRows = 8,
): SidebarHostModel {
  switch (mode) {
    case "single-focus": {
      const focus = rows.find((row) => row.active) ?? rows[0]
      if (!focus) return buildOverviewHostModel(api, rows, maxOverviewRows)
      return buildSingleFocusHostModel(api, focus)
    }
    case "workflow-list":
      return buildWorkflowListHostModel(api, rows)
    default:
      return buildOverviewHostModel(api, rows, maxOverviewRows)
  }
}

export function buildSidebarViewModel(parts: {
  hasWorkflow: boolean
  hostMode: SidebarHostRenderMode
  host: SidebarHostModel
  workflowText?: string
  workflowDiagnostic?: string
}): SidebarViewModel {
  const workflowLines = splitWorkflowLines(parts.workflowText)
  const placeholder = resolvePlaceholder(parts.hasWorkflow, parts.hostMode, workflowLines, parts.host)
  return {
    hasWorkflow: parts.hasWorkflow,
    hostMode: parts.hostMode,
    workflowLines,
    workflowDiagnostic: parts.workflowDiagnostic,
    host: parts.host,
    placeholder,
  }
}

export function renderSidebarViewModelText(model: SidebarViewModel): string {
  const sections: string[] = []
  if (model.workflowLines.length > 0) {
    sections.push(model.workflowLines.join("\n"))
  } else if (model.hasWorkflow) {
    sections.push("SP: workflow active")
  } else if (model.hostMode !== "single-focus") {
    sections.push("Superpowers workflow\nnot started")
  }
  if (model.workflowDiagnostic) sections.push(model.workflowDiagnostic)
  sections.push(renderSidebarHostModelText(model.host))
  const combined = sections.filter((section) => section.trim().length > 0).join("\n\n").trim()
  if (combined) return combined
  return model.placeholder ?? "Superpowers sidebar\nwaiting for session state"
}

export function renderSidebarHostModelText(host: SidebarHostModel): string {
  switch (host.kind) {
    case "single-focus": {
      const lines = [
        "Session",
        `${activityMarker(host.activity)} ${displayActivity(host.activity)}`,
        host.title,
      ]
      if (host.detail) lines.push(host.detail)
      return lines.join("\n")
    }
    case "session-list": {
      const lines = [host.heading, host.summary]
      for (const row of host.rows) {
        lines.push(formatSessionRowText(row))
      }
      if (host.moreCount && host.moreCount > 0) lines.push(`+${host.moreCount} more`)
      return lines.join("\n")
    }
    case "message":
      return host.lines.join("\n")
  }
}

function buildSingleFocusHostModel(
  api: HostSessionSidebarReader,
  row: HostSessionRow,
): SidebarHostModel {
  const reader = {
    messages: api.state.session.messages?.bind(api.state.session),
    part: api.part?.bind(api),
  }
  const title = truncateLine(row.title || row.id, 56)
  const activity = formatSidebarSessionActivity(reader, row)
  const recent = extractLatestAssistantSnippet(reader, row.id)
  const detail = recent && recent !== activity && !activity.includes(recent.slice(0, 24))
    ? truncateLine(recent, 96)
    : undefined
  return { kind: "single-focus", title, activity, detail }
}

function buildWorkflowListHostModel(
  api: HostSessionSidebarReader,
  rows: HostSessionRow[],
): SidebarHostModel {
  if (rows.length === 0) {
    return { kind: "message", lines: ["Sessions", "none"] }
  }
  if (rows.length === 1 && rows[0]?.id === "summary") {
    return {
      kind: "message",
      lines: ["Sessions", rows[0].title, "session list unavailable in this host build"],
    }
  }
  const reader = sessionMessageReader(api)
  const sorted = sortHostSessions(rows)
  const running = sorted.filter((row) => row.active).length
  return {
    kind: "session-list",
    heading: "Sessions",
    summary: `total ${sorted.length} | running ${running}`,
    rows: sorted.map((row) => ({
      ...toSidebarSessionRow(row, row.active ? "●" : " "),
      activity: row.active ? formatSidebarSessionActivity(reader, row) : undefined,
    })),
  }
}

function buildOverviewHostModel(
  api: HostSessionSidebarReader,
  rows: HostSessionRow[],
  maxRows: number,
): SidebarHostModel {
  if (rows.length === 0) {
    return { kind: "message", lines: ["OpenCode sessions", "none"] }
  }
  if (rows.length === 1 && rows[0]?.id === "summary") {
    return {
      kind: "message",
      lines: ["OpenCode sessions", rows[0].title, "session list unavailable in this host build"],
    }
  }
  const reader = sessionMessageReader(api)
  const total = rows.length
  const running = rows.filter((row) => row.active).length
  const visible = sortHostSessions(rows).slice(0, maxRows)
  return {
    kind: "session-list",
    heading: "OpenCode sessions",
    summary: `total ${total} | running ${running}`,
    rows: visible.map((row, index) => ({
      ...toSidebarSessionRow(
        row,
        index === 0 ? ">" : " ",
        index < 9 ? `⌘${index + 1}` : undefined,
      ),
      activity: row.active ? formatSidebarSessionActivity(reader, row) : undefined,
    })),
    moreCount: rows.length > maxRows ? rows.length - maxRows : undefined,
  }
}

function toSidebarSessionRow(
  row: HostSessionRow,
  marker: string,
  shortcut?: string,
): SidebarSessionRow {
  return {
    marker,
    shortcut: shortcut ? `[${shortcut}] ` : "",
    agent: row.agent,
    parentSuffix: row.parent_id ? " child" : "",
    status: row.live_status,
    title: truncateLine(row.title || row.id, 72),
    active: row.active,
  }
}

function formatSessionRowText(row: SidebarSessionRow): string {
  const summary = row.activity || fallbackSessionSummary(row)
  return `${row.marker} ${row.shortcut}${row.agent}${row.parentSuffix}: ${summary}`
}

function fallbackSessionSummary(row: SidebarSessionRow): string {
  const status = !row.status || row.status === "unknown" ? "idle" : row.status
  const title = row.title.trim()
  if (!title || title === row.agent) return status
  return `${status} · ${title}`
}

function activityMarker(activity: string): string {
  if (activity.startsWith("calling ") || activity.startsWith("↳")) return "↳"
  if (activity.startsWith("last ")) return "·"
  if (activity.includes("thinking")) return "•"
  if (activity.includes("permission")) return "!"
  return "•"
}

function displayActivity(activity: string): string {
  if (activity.startsWith("↳ ")) return activity.slice(2)
  if (activity.startsWith("calling ")) return activity.slice("calling ".length)
  return activity
}

function sessionMessageReader(api: HostSessionSidebarReader): import("./live-activity").SessionMessageReader {
  return {
    messages: api.state.session.messages?.bind(api.state.session),
    part: api.part?.bind(api),
  }
}

function splitWorkflowLines(workflowText?: string): string[] {
  if (!workflowText?.trim()) return []
  return workflowText.split("\n").filter((line) => line.length > 0)
}

function resolvePlaceholder(
  hasWorkflow: boolean,
  hostMode: SidebarHostRenderMode,
  workflowLines: string[],
  host: SidebarHostModel,
): string | undefined {
  const hasHostContent = host.kind === "message"
    ? host.lines.length > 0
    : host.kind === "single-focus" || host.rows.length > 0
  if (workflowLines.length > 0 || hasWorkflow || hasHostContent) return undefined
  return hostMode === "single-focus" ? "Session running" : "Superpowers sidebar\nwaiting for session state"
}

function truncateLine(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

// Re-export for callers that already sort via host-sessions internals.
function sortHostSessions(rows: HostSessionRow[]): HostSessionRow[] {
  return [...rows].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1
    return right.updated_at - left.updated_at
  })
}
