import "@opentui/solid/runtime-plugin-support"
import { existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { createElement, insert } from "@opentui/solid"
import { createSignal, onCleanup, type Accessor } from "solid-js"
import { createNodeProgressStore } from "./progress/node-progress"
import type { NodeProgressEntry } from "./progress/node-progress"
import { createProjectStore, readCurrentWorkflowState } from "./state/store"
import { projectStateRoot } from "./state/paths"
import {
  buildProgressPanelViewModel,
  renderAppBottomChildPanelText,
  renderCompactProgressText,
  renderProgressPanelText,
  renderRunningSessionsText,
  renderSidebarProgressText,
  renderWorkflowStatusText,
  shouldShowSidebarWorkflowProgress,
} from "./tui/progress-panel"
import { liveActivityBySession, isActiveHostSessionStatus, normalizeSessionLiveStatus } from "./tui/live-activity"
import {
  collectSeedSessionIDs,
  collectWorkflowSessionIDs,
  loadHostSessions,
  readHostSessionsSync,
  resolveSidebarHostRenderMode,
} from "./tui/host-sessions"
import { buildSidebarHostModel, buildSidebarViewModel, renderSidebarViewModelText, type SidebarViewModel } from "./tui/sidebar-model"
import { appendSidebarStartup, isSidebarDebugEnabled, logSidebarDiag, setSidebarDebugProjectDirectory, summarizeSidebarApi, summarizeSidebarModel } from "./tui/sidebar-debug"
import { createSessionMessageReader, primeSessionMessageCache } from "./tui/session-message-cache"
import type { WorkflowState } from "./state/types"

export const RESIDENT_PROGRESS_SLOT_NAMES = [
  "sidebar_content",
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
    register(plugin: { id: string; order?: number; slots: Record<string, (_context?: unknown, props?: Record<string, unknown>) => unknown> }): string
  }
  theme?: {
    current: {
      text?: string
      textMuted?: string
      warning?: string
      success?: string
      info?: string
    }
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
      worktree?: string
    }
    session: {
      count?(): number
      get?(sessionID: string): { id: string; title?: string; agent?: string; parentID?: string; directory?: string; time?: { updated?: number; created?: number } } | undefined
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
  client?: {
    session?: {
      list?(): Promise<unknown>
      messages?(input: { path: { id: string } }): Promise<unknown>
    }
  }
}

export function createTuiPluginModule() {
  return {
    id: "superpowers-controller",
    async tui(api: TuiApi, _options?: unknown, _meta?: unknown) {
      const startupAt = Date.now()
      const projectDirectory = api.state.path.directory
      setSidebarDebugProjectDirectory(projectDirectory)
      appendSidebarStartup(projectDirectory, {
        slots: RESIDENT_PROGRESS_SLOT_NAMES,
        debug: isSidebarDebugEnabled(projectDirectory),
      })
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
        order: 600,
        slots: residentProgressSlots(api),
      })
      logSidebarDiag("plugin_ready", {
        slots: RESIDENT_PROGRESS_SLOT_NAMES,
        debug: isSidebarDebugEnabled(projectDirectory),
      })
      const disposeNavigation = registerWorkflowSessionNavigation(api)
      if (disposeNavigation) disposers.push(disposeNavigation)
      api.lifecycle?.onDispose(() => {
        for (const dispose of disposers) dispose()
      })
      const startupMs = Date.now() - startupAt
      if (startupMs >= 100) {
        console.warn(`[superpowers-controller] tui startup: ${startupMs}ms`)
      }
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
  const current = api.route?.current
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
      : name === "sidebar_content"
        ? createSidebarProgressSlot(api, createTextElement, progressSlotOptions(name))
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
  if (options.renderer === "sidebar") {
    return createSidebarProgressSlot(api, renderText, options)
  }
  return (context, props) => {
    const slotContext = slotContextFromArgs(api, context, props)
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
    case "sidebar_content":
      return { renderer: "sidebar", allowGlobal: true, refreshOnEvents: true }
    default:
      return { renderer: "compact" }
  }
}

function slotContextFromArgs(api: TuiApi, context?: unknown, props?: Record<string, unknown>): { sessionID?: string } {
  return {
    sessionID: resolveSidebarSessionID(api, context, props),
  }
}

function resolveSidebarSessionID(api: TuiApi, context?: unknown, props?: Record<string, unknown>): string | undefined {
  return slotSessionID(props) ?? slotSessionID(context) ?? currentRouteSessionID(api)
}

function finalizeSidebarText(value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : "Superpowers sidebar\nwaiting for session state"
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
    if (renderer === "sidebar") return sidebarWorkflowProgressText(api, context.state, model)
    return renderCompactProgressText(model, maxChars)
  } catch {
    return "SP: progress unavailable"
  }
}

function createForegroundChildPromptSlot(api: TuiApi): (_context?: unknown, props?: Record<string, unknown>) => unknown {
  return (context, props) => {
    const currentSessionID = slotContextFromArgs(api, context, props).sessionID
    if (typeof currentSessionID !== "string") return null
    if (!api.ui?.Prompt) return null
    const workflow = currentWorkflowContext(api, currentSessionID).state
    if (!workflow) return null
    // Parent route keeps the host default prompt. Any workflow child route gets an explicit
    // Prompt so native parentID subagent pages (and design foreground) stay interactive.
    const node = workflow.node_runs.find((run) => run.session_id === currentSessionID)
    if (!node) return null
    const input = isRecord(props) ? props : isRecord(context) ? context : {}
    const childLabel = `${node.agent}${node.task_id ? ` ${node.task_id}` : ""}`
    // Do not pass string `hint`: OpenCode inserts `U.hint` as raw children under a box,
    // and orphan text-nodes fatal the TUI ("must have a <text> as a parent").
    return api.ui.Prompt({
      sessionID: currentSessionID,
      visible: typeof input.visible === "boolean" ? input.visible : undefined,
      disabled: typeof input.disabled === "boolean" ? input.disabled : undefined,
      onSubmit: typeof input.on_submit === "function" ? input.on_submit as () => void : undefined,
      ref: typeof input.ref === "function" ? input.ref as (ref: unknown) => void : undefined,
      showPlaceholder: true,
      placeholders: {
        normal: [`Reply to ${childLabel}`],
      },
    })
  }
}

function createSidebarProgressSlot(
  api: TuiApi,
  renderText: (value: TextSource) => unknown = createTextElement,
  options: CompactProgressSlotOptions = {},
): (_context?: unknown, props?: Record<string, unknown>) => unknown {
  // Keep sidebar_content on createTextElement path. Do not statically import sidebar-view.tsx:
  // bun build emits jsxDEV against @opentui/solid/jsx-dev-runtime, which only resolves to a .d.ts
  // and causes the whole TUI plugin module to fail before tui() runs.
  const primeSidebarMessages = (sessionID: string | undefined) => {
    const context = currentWorkflowContext(api, sessionID)
    const ids = new Set(collectWorkflowSessionIDs(context.state, sessionID))
    if (sessionID) ids.add(sessionID)
    primeSessionMessageCache(api, [...ids])
  }
  return (context, props) => {
    const sessionID = resolveSidebarSessionID(api, context, props)
    primeSidebarMessages(sessionID)
    const refreshMs = options.refreshMs ?? 1000
    const buildModel = () => assembleSidebarViewModel(api, sessionID, options.allowGlobal)
    const logRender = (renderer: "text" | "text_refresh", model: SidebarViewModel, error?: string) => {
      if (!isSidebarDebugEnabled()) return
      logSidebarDiag("render", {
        renderer,
        ...summarizeSidebarApi(api, sessionID),
        ...summarizeSidebarModel(model),
        error,
      })
    }
    const loadModel = async () => {
      try {
        const context = currentWorkflowContext(api, sessionID)
        if (shouldShowSidebarWorkflowProgress(context.state)) {
          const hostSessions = sidebarHostSessions(api, context, sessionID)
          return assembleSidebarViewModel(api, sessionID, options.allowGlobal, context, hostSessions)
        }
        const syncSessions = sidebarHostSessions(api, context, sessionID)
        if (resolveSidebarHostRenderMode(false, syncSessions) === "single-focus") {
          return assembleSidebarViewModel(api, sessionID, options.allowGlobal, context, syncSessions)
        }
        const hostSessions = await loadHostSessions(api, context.project, collectWorkflowSessionIDs(context.state, sessionID))
        return assembleSidebarViewModel(api, sessionID, options.allowGlobal, context, hostSessions)
      } catch (error) {
        logSidebarDiag("load_failed", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
        return fallbackSidebarViewModel()
      }
    }
    const renderSidebarText = () => {
      try {
        const model = buildModel()
        logRender("text", model)
        return renderText(finalizeSidebarText(renderSidebarViewModelText(model)))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logRender("text", fallbackSidebarViewModel(), message)
        return renderText(finalizeSidebarText("SP: progress unavailable"))
      }
    }
    if (refreshMs <= 0) {
      return renderSidebarText()
    }
    try {
      const [text, setText] = createSignal(finalizeSidebarText(renderSidebarViewModelText(buildModel())))
      logRender("text", buildModel())
      const scheduleRefresh = () => {
        primeSidebarMessages(sessionID)
        void loadModel()
          .then((model) => {
            const next = finalizeSidebarText(renderSidebarViewModelText(model))
            if (next) {
              setText(next)
              logRender("text_refresh", model)
            }
          })
          .catch(() => setText(finalizeSidebarText(renderSidebarViewModelText(buildModel()))))
      }
      const timer = setInterval(scheduleRefresh, refreshMs)
      const initialDeferred = setTimeout(scheduleRefresh, SIDEBAR_ASYNC_REFRESH_DEFER_MS)
      const eventDisposers = options.refreshOnEvents ? registerProgressRefreshEvents(api, scheduleRefresh) : []
      onCleanup(() => {
        clearInterval(timer)
        clearTimeout(initialDeferred)
        for (const dispose of eventDisposers) dispose()
      })
      return renderText(text)
    } catch {
      return renderSidebarText()
    }
  }
}

const SIDEBAR_ASYNC_REFRESH_DEFER_MS = 250

async function loadSidebarContentText(
  api: TuiApi,
  sessionID: string | undefined,
  allowGlobal = false,
): Promise<string> {
  try {
    const model = await loadSidebarViewModel(api, sessionID, allowGlobal)
    return finalizeSidebarText(renderSidebarViewModelText(model))
  } catch {
    return finalizeSidebarText("SP: progress unavailable")
  }
}

async function loadSidebarViewModel(
  api: TuiApi,
  sessionID: string | undefined,
  allowGlobal = false,
): Promise<SidebarViewModel> {
  const context = currentWorkflowContext(api, sessionID)
  if (shouldShowSidebarWorkflowProgress(context.state)) {
    const hostSessions = sidebarHostSessions(api, context, sessionID)
    return assembleSidebarViewModel(api, sessionID, allowGlobal, context, hostSessions)
  }
  const syncSessions = sidebarHostSessions(api, context, sessionID)
  if (resolveSidebarHostRenderMode(false, syncSessions) === "single-focus") {
    return assembleSidebarViewModel(api, sessionID, allowGlobal, context, syncSessions)
  }
  const hostSessions = await loadHostSessions(api, context.project, collectWorkflowSessionIDs(context.state, sessionID))
  return assembleSidebarViewModel(api, sessionID, allowGlobal, context, hostSessions)
}

function sidebarHostSessions(
  api: TuiApi,
  context: WorkflowContext,
  sessionID: string | undefined,
): ReturnType<typeof readHostSessionsSync> {
  const seedIDs = collectWorkflowSessionIDs(context.state, sessionID)
  let rows = readHostSessionsSync(api, seedIDs)
  const treatAsNoWorkflow = !shouldShowSidebarWorkflowProgress(context.state)
  if ((!context.state || treatAsNoWorkflow) && sessionID && rows.length === 0) {
    rows = readHostSessionsSync(api, [sessionID])
  }
  return rows
}

function sidebarContentText(
  api: TuiApi,
  sessionID: string | undefined,
  allowGlobal = false,
): string {
  try {
    return renderSidebarViewModelText(assembleSidebarViewModel(api, sessionID, allowGlobal))
  } catch {
    return finalizeSidebarText("SP: progress unavailable")
  }
}

function assembleSidebarViewModel(
  api: TuiApi,
  sessionID: string | undefined,
  allowGlobal = false,
  context = currentWorkflowContext(api, sessionID),
  hostSessions = sidebarHostSessions(api, context, sessionID),
): SidebarViewModel {
  const displayWorkflow = shouldShowSidebarWorkflowProgress(context.state)
  const hasWorkflow = displayWorkflow
  const hostMode = resolveSidebarHostRenderMode(hasWorkflow, hostSessions)
  const host = buildSidebarHostModel(
    sidebarHostReader(api),
    hostSessions,
    hostMode,
    hasWorkflow ? hostSessions.length : 8,
  )
  let workflowText = ""
  let workflowDiagnostic: string | undefined
  if (displayWorkflow && context.state) {
    const progress = createNodeProgressStore(context.project).readRun(context.state)
    const model = progressModel(api, context.state, progress, sessionID, allowGlobal)
    workflowText = sidebarWorkflowProgressText(api, context.state, model)
    if (context.diagnostic) workflowDiagnostic = context.diagnostic
  } else if (context.diagnostic && hostMode !== "single-focus") {
    workflowDiagnostic = context.diagnostic
  }
  return buildSidebarViewModel({
    hasWorkflow,
    hostMode,
    host,
    workflowText,
    workflowDiagnostic,
  })
}

function fallbackSidebarViewModel(): SidebarViewModel {
  return buildSidebarViewModel({
    hasWorkflow: false,
    hostMode: "overview",
    host: { kind: "message", lines: ["SP: progress unavailable"] },
  })
}

function sidebarHostReader(api: TuiApi): import("./tui/host-sessions").HostSessionSidebarReader {
  const messageReader = createSessionMessageReader({
    state: api.state,
    client: api.client,
  })
  return {
    state: {
      ...api.state,
      session: {
        ...api.state.session,
        messages(sessionID: string) {
          return messageReader.messages?.(sessionID) ?? []
        },
      },
    },
    client: api.client,
    part: messageReader.part,
  }
}

function sidebarWorkflowProgressText(
  _api: TuiApi,
  _state: WorkflowState | null,
  model: ReturnType<typeof buildProgressPanelViewModel>,
): string {
  // Keep workflow status compact. Host Sessions rows carry live tool activity;
  // do not dump foreground transcript / thinking into the sidebar.
  return renderSidebarProgressText(model)
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
  const candidate = selectWorkflowCandidate(api, sessionID)
  if (candidate) {
    const state = healInterruptedBusySessionsInTui(api, candidate.project, candidate.state) ?? candidate.state
    return {
      project: candidate.project,
      state,
      diagnostic: workflowContextDiagnostic({ ...candidate, state }, directory),
    }
  }

  return {
    project: directory,
    state: null,
    diagnostic: `SP: no workflow state in ${formatProjectPath(directory, directory)}`,
  }
}

function healInterruptedBusySessionsInTui(
  api: TuiApi,
  project: string,
  state: WorkflowState,
): WorkflowState | null {
  const busyInterruptedSessionIDs = state.node_runs
    .filter((node) => node.status === "interrupted")
    .filter((node) => isActiveHostSessionStatus(readTuiSessionLiveStatus(api, node.session_id)))
    .map((node) => node.session_id)
  if (busyInterruptedSessionIDs.length === 0) return null
  try {
    return getTuiProjectStore(project).healInterruptedBusySessions({
      sessionIDs: busyInterruptedSessionIDs,
      reason: "TUI sidebar observed host session still busy after a false startup interruption.",
    })
  } catch {
    return null
  }
}

function readTuiSessionLiveStatus(api: TuiApi, sessionID: string): string {
  try {
    const status = api.state.session.status?.(sessionID)
    if (!status) return "unknown"
    if (status.type === "retry") return "retry"
    return normalizeSessionLiveStatus(status.type)
  } catch {
    return "unknown"
  }
}

function selectWorkflowCandidate(api: TuiApi, sessionID?: unknown): WorkflowCandidate | null {
  const candidates = workflowCandidates(api, sessionID)
  const session = typeof sessionID === "string" ? sessionID : undefined
  if (session) {
    const matched = candidates.filter((candidate) => isWorkflowSession(candidate.state, session))
    const unfinishedMatched = latestWorkflowCandidate(matched.filter((candidate) => isUnfinishedWorkflow(candidate.state)))
    if (unfinishedMatched) return unfinishedMatched
    const runningMatched = latestWorkflowCandidate(matched.filter((candidate) => candidate.state.node_runs.some((node) => node.status === "running")))
    if (runningMatched) return runningMatched
    const currentMatched = matched.find((candidate) => candidate.source === "current")
    if (currentMatched) return currentMatched
    const matchedLatest = latestWorkflowCandidate(matched)
    if (matchedLatest) return matchedLatest
  }

  const unfinished = latestWorkflowCandidate(candidates.filter((candidate) => isUnfinishedWorkflow(candidate.state)))
  if (unfinished) return unfinished

  return latestWorkflowCandidate(candidates)
}

function workflowCandidates(api: TuiApi, sessionID?: unknown): WorkflowCandidate[] {
  const fast = workflowCandidatesFromRoots(api, sessionID, false)
  if (!workflowCandidatesNeedHistory(fast, sessionID)) return fast
  return workflowCandidatesFromRoots(api, sessionID, true)
}

function workflowCandidatesNeedHistory(candidates: WorkflowCandidate[], sessionID?: unknown): boolean {
  if (typeof sessionID === "string") {
    return !candidates.some((candidate) => isWorkflowSession(candidate.state, sessionID))
  }
  if (candidates.some((candidate) => isUnfinishedWorkflow(candidate.state))) return false
  return candidates.length === 0
}

function workflowCandidatesFromRoots(
  api: TuiApi,
  sessionID: unknown,
  includeHistory: boolean,
): WorkflowCandidate[] {
  const seen = new Set<string>()
  const result: WorkflowCandidate[] = []
  for (const project of projectLookupRoots(api, sessionID)) {
    for (const candidate of workflowCandidatesForProject(project, includeHistory)) {
      const key = `${candidate.project}:${candidate.state.id}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(candidate)
    }
  }
  return result
}

function projectLookupRoots(api: TuiApi, sessionID?: unknown): string[] {
  const directory = api.state.path.directory
  const sessionDirectory = resolveSessionProjectDirectory(api, sessionID)
  const roots = [
    sessionDirectory,
    directory,
    api.state.path.worktree,
    ...workflowProjectCandidates(directory),
  ]
  return [...new Set(roots.filter((root): root is string => Boolean(root)))]
}

function resolveSessionProjectDirectory(api: TuiApi, sessionID?: unknown): string | undefined {
  if (typeof sessionID !== "string") return undefined
  const session = api.state.session.get?.(sessionID)
  const directory = session?.directory?.trim()
  return directory || undefined
}

function workflowCandidatesForProject(project: string, includeHistory: boolean): WorkflowCandidate[] {
  const superpowersRoot = projectStateRoot(project)
  if (!existsSync(superpowersRoot)) return []
  const candidates: WorkflowCandidate[] = []
  const current = readCurrentWorkflowState(project)
  if (current) candidates.push({ project, state: current, source: "current" })
  if (!includeHistory) return candidates
  for (const state of getTuiProjectStore(project).listRuns()) {
    if (current?.id === state.id) continue
    candidates.push({ project, state, source: "run" })
  }
  return candidates
}

const tuiProjectStoreCache = new Map<string, ReturnType<typeof createProjectStore>>()

function getTuiProjectStore(project: string): ReturnType<typeof createProjectStore> {
  const cached = tuiProjectStoreCache.get(project)
  if (cached) return cached
  const store = createProjectStore(project)
  tuiProjectStoreCache.set(project, store)
  return store
}

function readWorkflowState(project: string): WorkflowState | null {
  return readCurrentWorkflowState(project)
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

function liveStatusBySession(api: TuiApi, state: WorkflowState | null): Record<string, string> {
  const result: Record<string, string> = {}
  for (const node of state?.node_runs ?? []) {
    try {
      result[node.session_id] = formatSessionStatus(api.state.session.status(node.session_id))
    } catch {
      result[node.session_id] = "unknown"
    }
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
