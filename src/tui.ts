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
  renderAppBottomChildPanelText,
  renderCompactProgressText,
  renderProgressPanelText,
  renderRunningSessionsText,
  renderSidebarProgressText,
  renderWorkflowStatusText,
} from "./tui/progress-panel"
import { liveActivityBySession } from "./tui/live-activity"
import type { WorkflowState } from "./state/types"

export const RESIDENT_PROGRESS_SLOT_NAMES = [
  "sidebar_content",
  "app_bottom",
  "session_prompt",
] as const

type ProgressSlotRenderer = "compact" | "workflow-status" | "app-bottom-panel" | "running-sessions" | "sidebar"

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

type TuiRouteCurrent =
  | { name: "session"; params: { sessionID: string; initialPrompt?: string } }
  | { name: string; params?: Record<string, unknown> }

type TuiKeymapCommand = {
  name: string
  title: string
  category?: string
  namespace?: string
  desc?: string
  hidden?: boolean
  run(): void
}

type TuiKeymapBinding = {
  key: string
  cmd: string
  desc?: string
}

type TuiApi = {
  route: {
    register(routes: Array<{ name: string; render(input?: { params?: Record<string, unknown> }): unknown }>): () => void
    navigate(name: string, params?: Record<string, unknown>): void
    current?: TuiRouteCurrent
  }
  command?: {
    register(callback: () => Array<{ title: string; value: string; description?: string; category?: string; onSelect?: () => void }>): () => void
  }
  keymap?: {
    registerLayer(layer: {
      mode?: string
      commands?: TuiKeymapCommand[]
      bindings?: TuiKeymapBinding[]
    }): (() => void) | void
  }
  slots?: {
    register(plugin: { id: string; slots: Record<string, (_context?: unknown, props?: Record<string, unknown>) => unknown> }): string
  }
  ui?: {
    Prompt(props: {
      sessionID?: string
      visible?: boolean
      disabled?: boolean
      onSubmit?: () => void
      ref?: (ref: unknown) => void
      hint?: unknown
      showPlaceholder?: boolean
      placeholders?: {
        normal?: string[]
        shell?: string[]
      }
    }): unknown
  }
  state: {
    path: {
      directory: string
    }
    session: {
      messages?(sessionID: string): ReadonlyArray<unknown>
      status(sessionID: string): { type: string; attempt?: number; message?: string } | undefined
      permission?(sessionID: string): ReadonlyArray<unknown>
      question?(sessionID: string): ReadonlyArray<unknown>
    }
    part?(messageID: string): ReadonlyArray<unknown>
  }
  lifecycle?: {
    onDispose(fn: () => void): () => void
  }
  event?: {
    on(type: string, handler: () => void): (() => void) | void
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
              buildProgressPanelViewModel(
                context.state,
                progress,
                liveStatusBySession(api, context.state),
                new Date(),
                undefined,
                childLiveActivityBySession(api, context.state),
              ),
            )
            return context.diagnostic ? `${text}\n\n${context.diagnostic}` : text
          },
        },
      ]))
      api.slots?.register({
        id: "superpowers-controller",
        slots: residentProgressSlots(api),
      })
      const disposeNavigation = registerWorkflowSessionNavigation(api)
      if (disposeNavigation) disposers.push(disposeNavigation)
      api.lifecycle?.onDispose(() => {
        for (const dispose of disposers) dispose()
      })
    },
  }
}

function registerWorkflowSessionNavigation(api: TuiApi): (() => void) | undefined {
  const disposers: Array<() => void> = []
  if (typeof api.keymap?.registerLayer === "function") {
    const dispose = api.keymap.registerLayer({
      mode: "base",
      commands: workflowSessionKeymapCommands(api),
      bindings: workflowSessionKeymapBindings(),
    })
    if (typeof dispose === "function") disposers.push(dispose)
  }
  if (api.command) {
    disposers.push(api.command.register(() => workflowSessionCommands(api)))
  }
  if (disposers.length === 0) return undefined
  return () => {
    for (const dispose of disposers) dispose()
  }
}

function workflowSessionKeymapCommands(api: TuiApi): TuiKeymapCommand[] {
  const commands: TuiKeymapCommand[] = [
    {
      name: "superpowers.open-parent",
      title: "Superpowers: Open parent workflow session",
      category: "Superpowers",
      namespace: "palette",
      run() {
        const state = currentWorkflowContext(api, currentRouteSessionID(api)).state
        if (!state) return
        api.route.navigate("session", { sessionID: state.parent_session_id })
      },
    },
    {
      name: "superpowers.cycle-child.prev",
      title: "Superpowers: Previous child session",
      category: "Superpowers",
      hidden: true,
      run() {
        cycleWorkflowSession(api, -1)
      },
    },
    {
      name: "superpowers.cycle-child.next",
      title: "Superpowers: Next child session",
      category: "Superpowers",
      hidden: true,
      run() {
        cycleWorkflowSession(api, 1)
      },
    },
  ]
  for (let index = 1; index <= 9; index += 1) {
    commands.push({
      name: `superpowers.open-child.${index}`,
      title: `Superpowers: Open child session ${index}`,
      category: "Superpowers",
      hidden: true,
      run() {
        openWorkflowChildSession(api, index - 1)
      },
    })
  }
  return commands
}

function workflowSessionKeymapBindings(): TuiKeymapBinding[] {
  const bindings: TuiKeymapBinding[] = [
    { key: "meta+[", cmd: "superpowers.cycle-child.prev", desc: "Previous child session" },
    { key: "meta+]", cmd: "superpowers.cycle-child.next", desc: "Next child session" },
  ]
  for (let index = 1; index <= 9; index += 1) {
    bindings.push({
      key: `meta+${index}`,
      cmd: `superpowers.open-child.${index}`,
      desc: `Open child session ${index}`,
    })
  }
  return bindings
}

function openWorkflowChildSession(api: TuiApi, rowIndex: number): void {
  const row = workflowNavigationRows(api)[rowIndex]
  if (!row) return
  api.route.navigate("session", { sessionID: row.session_id })
}

function cycleWorkflowSession(api: TuiApi, direction: -1 | 1): void {
  const rows = workflowNavigationRows(api)
  if (rows.length === 0) return
  const currentSessionID = currentRouteSessionID(api)
  const currentIndex = currentSessionID ? rows.findIndex((row) => row.session_id === currentSessionID) : -1
  const nextIndex = currentIndex < 0
    ? (direction > 0 ? 0 : rows.length - 1)
    : (currentIndex + direction + rows.length) % rows.length
  const next = rows[nextIndex]
  if (!next) return
  api.route.navigate("session", { sessionID: next.session_id })
}

function workflowNavigationRows(api: TuiApi) {
  return currentProgressModel(api, currentRouteSessionID(api)).rows
}

function currentRouteSessionID(api: TuiApi): string | undefined {
  const current = api.route.current
  if (current?.name !== "session") return undefined
  const sessionID = current.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function workflowSessionCommands(api: TuiApi): Array<{ title: string; value: string; description?: string; category?: string; onSelect?: () => void }> {
  const context = currentWorkflowContext(api)
  const state = context.state
  if (!state) return []
  const commands = [
    {
      title: "Superpowers: Open parent workflow session",
      value: `superpowers.open-session.${state.parent_session_id}`,
      description: `${state.workflow} ${state.status}@${state.current_phase}`,
      category: "Superpowers",
      onSelect: () => api.route.navigate("session", { sessionID: state.parent_session_id }),
    },
  ]
  for (const node of state.node_runs) {
    const task = node.task_id ? ` ${node.task_id}` : ""
    commands.push({
      title: `Superpowers: Open ${node.agent}${task}`,
      value: `superpowers.open-session.${node.session_id}`,
      description: `${node.phase} ${node.status} (${node.session_id})`,
      category: "Superpowers",
      onSelect: () => api.route.navigate("session", { sessionID: node.session_id }),
    })
  }
  return commands
}

function residentProgressSlots(api: TuiApi): Record<string, (_context?: unknown, props?: Record<string, unknown>) => unknown> {
  return Object.fromEntries(RESIDENT_PROGRESS_SLOT_NAMES.map((name) => [
    name,
    name === "session_prompt"
      ? createForegroundChildPromptSlot(api)
      : createProgressSlot(api, createTextElement, {
        ...progressSlotOptions(name),
      }),
  ]))
}

type TextSource = string | Accessor<string>

type CompactProgressSlotOptions = {
  refreshMs?: number
  maxChars?: number
  renderer?: ProgressSlotRenderer
  allowGlobal?: boolean
  requireSession?: boolean
  refreshOnEvents?: boolean
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
    if (options.requireSession && !hasSession) return null
    const refreshMs = options.refreshMs ?? 1000
    if (refreshMs <= 0) {
      const text = safeProgressSlotText(api, sessionID, hasSession, options.renderer ?? "compact", options.maxChars, options.allowGlobal)
      return text ? renderText(text) : null
    }
    const initialText = safeProgressSlotText(api, sessionID, hasSession, options.renderer ?? "compact", options.maxChars, options.allowGlobal)
    if (!initialText && !hasSession && !options.allowGlobal) return null
    const [text, setText] = createSignal(initialText)
    const refresh = () => {
      setText(safeProgressSlotText(api, sessionID, hasSession, options.renderer ?? "compact", options.maxChars, options.allowGlobal))
    }
    const timer = setInterval(refresh, refreshMs)
    refresh()
    const eventDisposers = options.refreshOnEvents ? registerProgressRefreshEvents(api, refresh) : []
    onCleanup(() => {
      clearInterval(timer)
      for (const dispose of eventDisposers) dispose()
    })
    return renderText(text)
  }
}

function progressSlotOptions(slotName: string): Pick<CompactProgressSlotOptions, "renderer" | "maxChars" | "allowGlobal" | "requireSession" | "refreshOnEvents"> {
  switch (slotName) {
    case "app_bottom":
      return { renderer: "app-bottom-panel", allowGlobal: true, refreshOnEvents: true }
    case "sidebar_content":
      return { renderer: "sidebar", allowGlobal: true, refreshOnEvents: true }
    default:
      return { renderer: "compact" }
  }
}

function slotContextFromArgs(context?: unknown, props?: Record<string, unknown>): { sessionID?: string } {
  return {
    sessionID: slotSessionID(props) ?? slotSessionID(context),
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

function safeProgressSlotText(
  api: TuiApi,
  sessionID: unknown,
  hasSession: boolean,
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
    const model = progressModel(api, context.state, progress, sessionID, allowGlobal)
    if (!allowGlobal && renderer !== "compact" && !hasSession) return ""
    if (renderer === "workflow-status") return renderWorkflowStatusText(model, maxChars)
    if (renderer === "app-bottom-panel") return renderAppBottomChildPanelText(model)
    if (renderer === "running-sessions") return renderRunningSessionsText(model)
    if (renderer === "sidebar") return sidebarProgressText(api, context.state, model)
    return renderCompactProgressText(model, maxChars)
  } catch {
    return "SP: progress unavailable"
  }
}

function createForegroundChildPromptSlot(api: TuiApi): (_context?: unknown, props?: Record<string, unknown>) => unknown {
  return (context, props) => {
    const currentSessionID = slotContextFromArgs(context, props).sessionID
    if (typeof currentSessionID !== "string") return null
    const workflow = currentWorkflowContext(api, currentSessionID).state
    const foreground = workflow ? foregroundChildNode(workflow) : undefined
    if (!workflow || !foreground) return null
    if (currentSessionID !== workflow.parent_session_id && currentSessionID !== foreground.session_id) return null
    if (!api.ui?.Prompt) return `SP foreground child: ${foreground.agent}${foreground.task_id ? ` ${foreground.task_id}` : ""}`
    const input = isRecord(props) ? props : isRecord(context) ? context : {}
    const targetSessionID = currentSessionID === foreground.session_id ? currentSessionID : foreground.session_id
    return api.ui.Prompt({
      sessionID: targetSessionID,
      visible: typeof input.visible === "boolean" ? input.visible : undefined,
      disabled: typeof input.disabled === "boolean" ? input.disabled : undefined,
      onSubmit: typeof input.on_submit === "function" ? input.on_submit as () => void : undefined,
      ref: typeof input.ref === "function" ? input.ref as (ref: unknown) => void : undefined,
      hint: `SP -> ${foreground.agent}${foreground.task_id ? ` ${foreground.task_id}` : ""}`,
      showPlaceholder: true,
      placeholders: {
        normal: [`Reply to ${foreground.agent}${foreground.task_id ? ` ${foreground.task_id}` : ""}`],
      },
    })
  }
}

function sidebarProgressText(api: TuiApi, state: WorkflowState | null, model: ReturnType<typeof buildProgressPanelViewModel>): string {
  const base = renderSidebarProgressText(model)
  if (!state) return base
  const foreground = foregroundChildNode(state)
  if (!foreground) return base
  const transcript = renderForegroundChildTranscript(api, foreground.session_id)
  if (!transcript) return base
  return `${base}\n\nforeground child\n${foreground.agent}${foreground.task_id ? ` ${foreground.task_id}` : ""}: ${foreground.phase} ${foreground.status}\n${transcript}`
}

function registerProgressRefreshEvents(api: TuiApi, refresh: () => void): Array<() => void> {
  if (!api.event?.on) return []
  const types = ["message.part.updated", "message.part.delta", "session.status", "session.idle"]
  const disposers: Array<() => void> = []
  for (const type of types) {
    const dispose = api.event.on(type, refresh)
    if (typeof dispose === "function") disposers.push(dispose)
  }
  return disposers
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
  const focusedSessionID = typeof sessionID === "string" && state && isWorkflowSession(state, sessionID)
    ? sessionID
    : undefined
  return buildProgressPanelViewModel(
    state,
    progress,
    liveStatusBySession(api, state),
    new Date(),
    focusedSessionID,
    childLiveActivityBySession(api, state),
  )
}

function isWorkflowSession(state: WorkflowState, sessionID: string): boolean {
  return sessionID === state.parent_session_id || state.node_runs.some((node) => node.session_id === sessionID)
}

function foregroundChildNode(state: WorkflowState): WorkflowState["node_runs"][number] | undefined {
  if (state.pending_question?.source_node_id) {
    const questionNode = state.node_runs.find((node) => node.id === state.pending_question?.source_node_id)
    if (questionNode && isForegroundSerialPhase(questionNode.phase)) return questionNode
  }
  if (state.status === "awaiting_design_approval") {
    return [...state.node_runs].reverse().find((node) => node.phase === "design")
  }
  if (state.status === "awaiting_plan_approval") {
    return [...state.node_runs].reverse().find((node) => node.phase === "plan")
  }
  return [...state.node_runs].reverse().find((node) => node.status === "running")
}

function isForegroundSerialPhase(phase: string): boolean {
  return phase === "design" || phase === "plan"
}

function renderForegroundChildTranscript(api: TuiApi, sessionID: string): string {
  const lines: string[] = []
  const status = formatSessionStatus(api.state.session.status(sessionID))
  lines.push(`live: ${status}`)
  const permissions = api.state.session.permission?.(sessionID) ?? []
  const questions = api.state.session.question?.(sessionID) ?? []
  if (permissions.length > 0) lines.push(`permissions: ${permissions.length} pending`)
  if (questions.length > 0) lines.push(`questions: ${questions.length} pending`)
  const messages = api.state.session.messages?.(sessionID) ?? []
  const rendered = messages.slice(-4).flatMap((message) => renderMessageLines(api, message))
  if (rendered.length > 0) {
    lines.push("recent")
    lines.push(...rendered.slice(-12))
  }
  return lines.join("\n")
}

function renderMessageLines(api: TuiApi, message: unknown): string[] {
  if (!isRecord(message)) return []
  const info = isRecord(message.info) ? message.info : message
  const messageID = typeof info.id === "string" ? info.id : undefined
  const role = typeof info.role === "string" ? info.role : "message"
  const parts = Array.isArray(message.parts)
    ? message.parts
    : messageID && api.state.part
      ? api.state.part(messageID)
      : []
  const text = parts.flatMap(renderPartText).filter(Boolean).join(" | ")
  if (!text) return [`${role}: ${messageID ?? "no text"}`]
  return [`${role}: ${truncateSlotText(text.replace(/\s+/g, " "), 220)}`]
}

function renderPartText(part: unknown): string[] {
  if (!isRecord(part) || typeof part.type !== "string") return []
  if (part.type === "text" && typeof part.text === "string") return [part.text]
  if (part.type === "reasoning" && typeof part.text === "string") return [`thinking: ${part.text}`]
  if (part.type === "tool") return [renderToolPart(part)]
  if (part.type === "patch" && Array.isArray(part.files)) return [`patch: ${part.files.join(", ")}`]
  if (part.type === "agent" && typeof part.name === "string") return [`agent: ${part.name}`]
  if (part.type === "step-finish" && typeof part.reason === "string") return [`step: ${part.reason}`]
  return []
}

function renderToolPart(part: Record<string, unknown>): string {
  const tool = typeof part.tool === "string" ? part.tool : "tool"
  const state = isRecord(part.state) && typeof part.state.status === "string" ? part.state.status : "unknown"
  const title = isRecord(part.state) && typeof part.state.title === "string" ? ` ${part.state.title}` : ""
  return `${tool}: ${state}${title}`
}

function liveStatusBySession(api: TuiApi, state: WorkflowState | null): Record<string, string> {
  const result: Record<string, string> = {}
  for (const node of state?.node_runs ?? []) {
    result[node.session_id] = formatSessionStatus(api.state.session.status(node.session_id))
  }
  return result
}

function childLiveActivityBySession(api: TuiApi, state: WorkflowState | null): Record<string, import("./tui/live-activity").ChildLiveActivity> {
  if (!state) return {}
  return liveActivityBySession(api.state.session, state.node_runs.map((node) => node.session_id))
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
