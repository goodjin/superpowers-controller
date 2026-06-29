import "@opentui/solid/runtime-plugin-support"
import { existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { createElement, insert } from "@opentui/solid"
import { createSignal, onCleanup, type Accessor } from "solid-js"
import { createNodeProgressStore } from "./progress/node-progress"
import type { NodeProgressEntry } from "./progress/node-progress"
import { createProjectStore } from "./state/store"
import {
  buildProgressPanelViewModel,
  renderCompactProgressText,
  renderProgressPanelText,
  renderRunningSessionsText,
  renderSidebarProgressText,
  renderWorkflowStatusText,
} from "./tui/progress-panel"
import type { WorkflowState } from "./state/types"

export const RESIDENT_PROGRESS_SLOT_NAMES = [
  "sidebar_footer",
  "sidebar_content",
  "app_bottom",
] as const

type ProgressSlotRenderer = "compact" | "workflow-status" | "running-sessions" | "sidebar"

type WorkflowContext = {
  project: string
  state: WorkflowState | null
  diagnostic?: string
}

type WorkflowCandidate = {
  project: string
  state: WorkflowState
  source: "current" | "run"
}

type TuiApi = {
  route: {
    register(routes: Array<{ name: string; render(input?: { params?: Record<string, unknown> }): unknown }>): () => void
    navigate(name: string, params?: Record<string, unknown>): void
  }
  command?: {
    register(callback: () => Array<{ title: string; value: string; description?: string; category?: string; onSelect?: () => void }>): () => void
  }
  slots?: {
    register(plugin: { slots: Record<string, (_context?: unknown, props?: Record<string, unknown>) => unknown> }): string
  }
  state: {
    path: {
      directory: string
    }
    session: {
      status(sessionID: string): { type: string; attempt?: number; message?: string } | undefined
    }
  }
  lifecycle?: {
    onDispose(fn: () => void): () => void
  }
}

export function createTuiPluginModule() {
  return {
    id: "superpowers-controller",
    async tui(api: TuiApi, _options?: unknown, _meta?: unknown) {
      const disposers: Array<() => void> = []
      disposers.push(api.route.register([
        {
          name: "superpowers-progress",
          render() {
            const context = currentWorkflowContext(api)
            const progress = context.state ? createNodeProgressStore(context.project).readRun(context.state) : {}
            const text = renderProgressPanelText(
              buildProgressPanelViewModel(context.state, progress, liveStatusBySession(api, context.state)),
            )
            return context.diagnostic ? `${text}\n\n${context.diagnostic}` : text
          },
        },
      ]))
      api.slots?.register({
        slots: residentProgressSlots((slotName) =>
          createProgressSlot(api, createTextElement, {
            ...progressSlotOptions(slotName),
          }),
        ),
      })
      if (api.command) {
        disposers.push(api.command.register(() => [
          {
            title: "Superpowers Progress",
            value: "superpowers.progress",
            description: "Open the Superpowers Controller progress panel",
            category: "Superpowers",
            onSelect: () => api.route.navigate("superpowers-progress"),
          },
        ]))
      }
      api.lifecycle?.onDispose(() => {
        for (const dispose of disposers) dispose()
      })
    },
  }
}

function residentProgressSlots(
  slotForName: (slotName: string) => (_context?: unknown, props?: Record<string, unknown>) => unknown,
): Record<string, (_context?: unknown, props?: Record<string, unknown>) => unknown> {
  return Object.fromEntries(RESIDENT_PROGRESS_SLOT_NAMES.map((name) => [name, slotForName(name)]))
}

type TextSource = string | Accessor<string>

type CompactProgressSlotOptions = {
  refreshMs?: number
  maxChars?: number
  renderer?: ProgressSlotRenderer
  allowGlobal?: boolean
}

export function createCompactProgressSlot(
  api: TuiApi,
  renderText: (value: TextSource) => unknown = createTextElement,
  options: CompactProgressSlotOptions = {},
): (_context?: unknown, props?: Record<string, unknown>) => unknown {
  return createProgressSlot(api, renderText, { renderer: "compact", ...options })
}

export function createProgressSlot(
  api: TuiApi,
  renderText: (value: TextSource) => unknown = createTextElement,
  options: CompactProgressSlotOptions = {},
): (_context?: unknown, props?: Record<string, unknown>) => unknown {
  return (context, props) => {
    const slotContext = slotContextFromArgs(context, props)
    const sessionID = slotContext.sessionID
    const hasSession = typeof sessionID === "string"
    const isControllerSession = slotContext.agent === "super-agent"
    const refreshMs = options.refreshMs ?? 1000
    if (refreshMs <= 0) {
      const text = safeProgressSlotText(api, sessionID, hasSession, isControllerSession, options.renderer ?? "compact", options.maxChars, options.allowGlobal)
      return text ? renderText(text) : null
    }
    const initialText = safeProgressSlotText(api, sessionID, hasSession, isControllerSession, options.renderer ?? "compact", options.maxChars, options.allowGlobal)
    if (!initialText && !hasSession && !options.allowGlobal) return null
    const [text, setText] = createSignal(initialText)
    const timer = setInterval(() => {
      setText(safeProgressSlotText(api, sessionID, hasSession, isControllerSession, options.renderer ?? "compact", options.maxChars, options.allowGlobal))
    }, refreshMs)
    setText(safeProgressSlotText(api, sessionID, hasSession, isControllerSession, options.renderer ?? "compact", options.maxChars, options.allowGlobal))
    onCleanup(() => clearInterval(timer))
    return renderText(text)
  }
}

function progressSlotOptions(slotName: string): Pick<CompactProgressSlotOptions, "renderer" | "maxChars" | "allowGlobal"> {
  switch (slotName) {
    case "app_bottom":
      return { renderer: "workflow-status", maxChars: 180, allowGlobal: false }
    case "sidebar_footer":
      return { renderer: "workflow-status", maxChars: 180, allowGlobal: true }
    case "sidebar_content":
      return { renderer: "sidebar", allowGlobal: true }
    default:
      return { renderer: "compact" }
  }
}

function slotContextFromArgs(context?: unknown, props?: Record<string, unknown>): { sessionID?: string; agent?: string } {
  return {
    sessionID: slotSessionID(props) ?? slotSessionID(context),
    agent: slotSessionAgent(props) ?? slotSessionAgent(context),
  }
}

function slotSessionID(value?: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.session_id === "string") return value.session_id
  if (typeof value.sessionID === "string") return value.sessionID
  const session = value.session
  if (isRecord(session) && typeof session.id === "string") return session.id
  return undefined
}

function slotSessionAgent(value?: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.agent === "string") return value.agent
  const session = value.session
  if (isRecord(session) && typeof session.agent === "string") return session.agent
  return undefined
}

function safeProgressSlotText(
  api: TuiApi,
  sessionID: unknown,
  hasSession: boolean,
  isControllerSession: boolean,
  renderer: ProgressSlotRenderer,
  maxChars?: number,
  allowGlobal = false,
): string {
  try {
    const context = currentWorkflowContext(api, sessionID)
    if (!context.state) {
      if (!allowGlobal && renderer !== "compact" && !hasSession) return ""
      return truncateSlotText(context.diagnostic ?? "SP: no active workflow", maxChars)
    }
    const progress = createNodeProgressStore(context.project).readRun(context.state)
    const model = progressModel(api, context.state, progress, sessionID, allowGlobal && isControllerSession)
    if (!allowGlobal && renderer !== "compact" && !hasSession) return ""
    if (renderer === "workflow-status") return renderWorkflowStatusText(model, maxChars)
    if (renderer === "running-sessions") return renderRunningSessionsText(model)
    if (renderer === "sidebar") return renderSidebarProgressText(model)
    return renderCompactProgressText(model, maxChars)
  } catch {
    return "SP: progress unavailable"
  }
}

function createTextElement(value: TextSource): unknown {
  const node = createElement("text")
  insert(node, value)
  return node
}

function currentProgressModel(api: TuiApi, sessionID?: unknown) {
  const context = currentWorkflowContext(api, sessionID)
  const progress = context.state ? createNodeProgressStore(context.project).readRun(context.state) : {}
  return progressModel(api, context.state, progress, sessionID)
}

function currentWorkflowContext(api: TuiApi, sessionID?: unknown): WorkflowContext {
  const directory = api.state.path.directory
  const candidate = selectWorkflowCandidate(directory, sessionID)
  if (candidate) {
    return {
      project: candidate.project,
      state: candidate.state,
      diagnostic: workflowContextDiagnostic(candidate, directory),
    }
  }

  return {
    project: directory,
    state: null,
    diagnostic: `SP: no workflow state in ${formatProjectPath(directory, directory)}`,
  }
}

function selectWorkflowCandidate(directory: string, sessionID?: unknown): WorkflowCandidate | null {
  const candidates = workflowCandidates(directory)
  const session = typeof sessionID === "string" ? sessionID : undefined
  if (session) {
    const matched = latestWorkflowCandidate(candidates.filter((candidate) => isWorkflowSession(candidate.state, session)))
    if (matched) return matched
  }

  const unfinished = latestWorkflowCandidate(candidates.filter((candidate) => isUnfinishedWorkflow(candidate.state)))
  if (unfinished) return unfinished

  return latestWorkflowCandidate(candidates)
}

function workflowCandidates(directory: string): WorkflowCandidate[] {
  const seen = new Set<string>()
  const result: WorkflowCandidate[] = []
  for (const project of [directory, ...workflowProjectCandidates(directory)]) {
    for (const candidate of workflowCandidatesForProject(project)) {
      const key = `${candidate.project}:${candidate.state.id}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(candidate)
    }
  }
  return result
}

function workflowCandidatesForProject(project: string): WorkflowCandidate[] {
  const store = createProjectStore(project)
  const candidates: WorkflowCandidate[] = []
  const current = readWorkflowState(project)
  if (current) candidates.push({ project, state: current, source: "current" })
  for (const state of store.listRuns()) {
    candidates.push({ project, state, source: "run" })
  }
  return candidates
}

function readWorkflowState(project: string): WorkflowState | null {
  if (!existsSync(join(project, ".opencode", "superpowers", "current.json"))) return null
  return createProjectStore(project).readCurrent()
}

function latestWorkflowCandidate(candidates: WorkflowCandidate[]): WorkflowCandidate | null {
  return [...candidates].sort(compareWorkflowCandidate).at(0) ?? null
}

function compareWorkflowCandidate(left: WorkflowCandidate, right: WorkflowCandidate): number {
  const updated = workflowTimestamp(right.state) - workflowTimestamp(left.state)
  if (updated !== 0) return updated
  if (left.source !== right.source) return left.source === "current" ? -1 : 1
  return left.state.id.localeCompare(right.state.id)
}

function workflowTimestamp(state: WorkflowState): number {
  const parsed = Date.parse(state.updated_at)
  return Number.isFinite(parsed) ? parsed : 0
}

function isUnfinishedWorkflow(state: WorkflowState): boolean {
  return [
    "intake",
    "running",
    "awaiting_design_approval",
    "awaiting_plan_approval",
    "waiting_user",
    "waiting_user_decision",
    "waiting_controller_decision",
    "blocked",
    "failed",
    "recovered_unknown",
  ].includes(state.status)
}

function workflowContextDiagnostic(candidate: WorkflowCandidate, directory: string): string | undefined {
  if (candidate.project !== directory) {
    return `SP: using workflow state from ${formatProjectPath(candidate.project, directory)}`
  }
  if (candidate.source !== "current") {
    return `SP: using latest workflow run ${candidate.state.id}`
  }
  return undefined
}

function workflowProjectCandidates(directory: string): string[] {
  const candidates = [
    process.env.SUPERAGENT_PROJECT_DIR,
    process.env.OPENCODE_SUPERPOWERS_PROJECT_DIR,
    process.env.SUPERAGENT_ROOT ? join(process.env.SUPERAGENT_ROOT, "project") : undefined,
    process.env.HOME ? join(dirname(process.env.HOME), "project") : undefined,
  ]
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate && candidate !== directory)))]
}

function formatProjectPath(project: string, directory: string): string {
  const rel = relative(directory, project)
  return rel && !rel.startsWith("..") ? rel : project
}

function truncateSlotText(value: string, maxChars?: number): string {
  if (!maxChars || value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`
}

function progressModel(
  api: TuiApi,
  state: WorkflowState | null,
  progress: Record<string, NodeProgressEntry[]>,
  sessionID?: unknown,
  allowControllerFallback = false,
) {
  if (typeof sessionID === "string" && state && !isWorkflowSession(state, sessionID) && !allowControllerFallback) {
    return buildProgressPanelViewModel(null, {}, {})
  }
  return buildProgressPanelViewModel(state, progress, liveStatusBySession(api, state))
}

function isWorkflowSession(state: WorkflowState, sessionID: string): boolean {
  return sessionID === state.parent_session_id || state.node_runs.some((node) => node.session_id === sessionID)
}

function liveStatusBySession(api: TuiApi, state: WorkflowState | null): Record<string, string> {
  const result: Record<string, string> = {}
  for (const node of state?.node_runs ?? []) {
    result[node.session_id] = formatSessionStatus(api.state.session.status(node.session_id))
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function formatSessionStatus(status: { type: string; attempt?: number; message?: string } | undefined): string {
  if (!status) return "unknown"
  if (status.type === "retry") return `retry ${status.attempt ?? "?"}${status.message ? `: ${status.message}` : ""}`
  return status.type
}

export default createTuiPluginModule()
