import { existsSync } from "node:fs"
import { join } from "node:path"
import { projectStateRoot } from "../state/paths"
import type { SidebarViewModel } from "./sidebar-model"
import { renderSidebarViewModelText } from "./sidebar-model"
import { appendSidebarDebugLog } from "./session-message-cache"

const LOG_PREFIX = "[superpowers-controller][sidebar]"

let lastProjectDirectory: string | undefined

function envDebugEnabled(): boolean {
  const value = process.env.SUPERPOWERS_TUI_DEBUG ?? process.env.SUPERPOWERS_SIDEBAR_DEBUG
  return value === "1" || value === "true" || value === "yes"
}

function fileDebugEnabled(projectDirectory?: string): boolean {
  if (!projectDirectory) return false
  return existsSync(join(projectStateRoot(projectDirectory), "sidebar-debug.enable"))
}

export function isSidebarDebugEnabled(projectDirectory?: string): boolean {
  return envDebugEnabled() || fileDebugEnabled(projectDirectory ?? lastProjectDirectory)
}

export function appendSidebarStartup(projectDirectory: string | undefined, detail: Record<string, unknown> = {}): void {
  if (projectDirectory) lastProjectDirectory = projectDirectory
  const payload = `${new Date().toISOString()} startup ${JSON.stringify({
    pid: process.pid,
    envDebug: envDebugEnabled(),
    fileDebug: fileDebugEnabled(projectDirectory),
    projectDirectory,
    ...detail,
  })}`
  appendSidebarDebugLog(projectDirectory, payload)
}

export function setSidebarDebugProjectDirectory(directory?: string): void {
  if (directory) lastProjectDirectory = directory
}

export function logSidebarDiag(event: string, detail: Record<string, unknown> = {}): void {
  if (!isSidebarDebugEnabled(lastProjectDirectory)) return
  const payload = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}`
  try {
    console.warn(`${LOG_PREFIX} ${event} ${JSON.stringify(detail)}`)
  } catch {
    console.warn(`${LOG_PREFIX} ${event}`)
  }
  appendSidebarDebugLog(lastProjectDirectory, payload)
}

export function summarizeSidebarModel(model: SidebarViewModel): Record<string, unknown> {
  const host = model.host
  if (host.kind === "single-focus") {
    return {
      hasWorkflow: model.hasWorkflow,
      hostMode: model.hostMode,
      hostKind: host.kind,
      title: host.title,
      activity: host.activity,
      detail: host.detail,
      workflowLineCount: model.workflowLines.length,
      textPreview: renderSidebarViewModelText(model).slice(0, 240),
    }
  }
  if (host.kind === "session-list") {
    return {
      hasWorkflow: model.hasWorkflow,
      hostMode: model.hostMode,
      hostKind: host.kind,
      rowCount: host.rows.length,
      firstRow: host.rows[0],
      workflowLineCount: model.workflowLines.length,
      textPreview: renderSidebarViewModelText(model).slice(0, 240),
    }
  }
  return {
    hasWorkflow: model.hasWorkflow,
    hostMode: model.hostMode,
    hostKind: host.kind,
    lines: host.lines,
    workflowLineCount: model.workflowLines.length,
    textPreview: renderSidebarViewModelText(model).slice(0, 240),
  }
}

export function summarizeSidebarApi(
  api: {
    state?: {
      session?: {
        messages?(sessionID: string): ReadonlyArray<unknown>
        get?(sessionID: string): unknown
        status?(sessionID: string): unknown
      }
    }
  },
  sessionID?: string,
): Record<string, unknown> {
  if (!sessionID) return { sessionID: null }
  const session = api.state?.session
  const messages = session?.messages?.(sessionID)
  return {
    sessionID,
    hasMessagesApi: typeof session?.messages === "function",
    hasGetApi: typeof session?.get === "function",
    hasStatusApi: typeof session?.status === "function",
    messageCount: Array.isArray(messages) ? messages.length : null,
    sessionTitle: typeof session?.get === "function"
      ? (session.get(sessionID) as { title?: string } | undefined)?.title
      : undefined,
    sessionStatus: typeof session?.status === "function" ? session.status(sessionID) : undefined,
  }
}
