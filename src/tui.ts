import "@opentui/solid/runtime-plugin-support"
import { existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { createNodeProgressStore } from "./progress/node-progress"
import type { NodeProgressEntry } from "./progress/node-progress"
import { createProjectStore } from "./state/store"
import {
  buildQuestionActions,
  createHttpQuestionBridgeClient,
  filterWorkflowQuestionRequests,
  renderCompactQuestionText,
  renderQuestionBridgeText,
  renderSidebarQuestionText,
  type QuestionAction,
  type QuestionBridgeClient,
  type QuestionRequest,
} from "./tui/question-bridge"
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
      const questionClient = createHttpQuestionBridgeClient()
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
        {
          name: "superpowers-questions",
          render() {
            return createQuestionBridgePanel(api, questionClient)
          },
        },
      ]))
      api.slots?.register({
        slots: residentProgressSlots((slotName) =>
          createProgressSlot(api, createTextElement, {
            questionClient,
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
          {
            title: "Superpowers Child Questions",
            value: "superpowers.questions",
            description: "Review and answer pending child-session questions",
            category: "Superpowers",
            onSelect: () => api.route.navigate("superpowers-questions"),
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
  questionClient?: QuestionBridgeClient
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
  return (_context, props) => {
    const sessionID = slotSessionID(props)
    const refreshMs = options.refreshMs ?? 1000
    if (refreshMs <= 0) {
      const text = safeProgressSlotText(api, sessionID, props, options.renderer ?? "compact", options.maxChars, options.allowGlobal)
      return text ? renderText(text) : null
    }
    const [text, setText] = createSignal(safeProgressSlotText(api, sessionID, props, options.renderer ?? "compact", options.maxChars, options.allowGlobal))
    const timer = setInterval(() => {
      void refreshProgressSlotText(api, sessionID, props, options.questionClient, options.renderer ?? "compact", options.maxChars, options.allowGlobal, setText)
    }, refreshMs)
    void refreshProgressSlotText(api, sessionID, props, options.questionClient, options.renderer ?? "compact", options.maxChars, options.allowGlobal, setText)
    onCleanup(() => clearInterval(timer))
    return renderText(text)
  }
}

function progressSlotOptions(slotName: string): Pick<CompactProgressSlotOptions, "renderer" | "maxChars" | "allowGlobal"> {
  switch (slotName) {
    case "app_bottom":
    case "sidebar_footer":
      return { renderer: "workflow-status", maxChars: 100, allowGlobal: true }
    case "sidebar_content":
      return { renderer: "sidebar", allowGlobal: true }
    default:
      return { renderer: "compact" }
  }
}

function slotSessionID(props?: Record<string, unknown>): unknown {
  return typeof props?.session_id === "string" ? props.session_id : props?.sessionID
}

function safeProgressSlotText(
  api: TuiApi,
  sessionID: unknown,
  props: Record<string, unknown> | undefined,
  renderer: ProgressSlotRenderer,
  maxChars?: number,
  allowGlobal = false,
): string {
  try {
    const context = currentWorkflowContext(api)
    if (!context.state) {
      if (!allowGlobal && renderer !== "compact" && typeof slotSessionID(props) !== "string") return ""
      return truncateSlotText(context.diagnostic ?? "SP: no active workflow", maxChars)
    }
    const progress = createNodeProgressStore(context.project).readRun(context.state)
    const model = progressModel(api, context.state, progress, sessionID)
    if (!allowGlobal && renderer !== "compact" && typeof slotSessionID(props) !== "string") return ""
    if (renderer === "workflow-status") return renderWorkflowStatusText(model, maxChars)
    if (renderer === "running-sessions") return renderRunningSessionsText(model)
    if (renderer === "sidebar") return renderSidebarProgressText(model)
    return renderCompactProgressText(model, maxChars)
  } catch {
    return "SP: progress unavailable"
  }
}

async function refreshProgressSlotText(
  api: TuiApi,
  sessionID: unknown,
  props: Record<string, unknown> | undefined,
  client: QuestionBridgeClient | undefined,
  renderer: ProgressSlotRenderer,
  maxChars: number | undefined,
  allowGlobal: boolean | undefined,
  setText: (value: string) => void,
): Promise<void> {
  try {
    if (!client) {
      setText(safeProgressSlotText(api, sessionID, props, renderer, maxChars, allowGlobal))
      return
    }
    const context = currentWorkflowContext(api)
    const questions = filterWorkflowQuestionRequests(context.state, await client.list(context.project))
    const questionText = renderer === "sidebar" ? renderSidebarQuestionText(questions) : renderer === "compact" ? renderCompactQuestionText(questions) : ""
    setText(questionText || safeProgressSlotText(api, sessionID, props, renderer, maxChars, allowGlobal))
  } catch {
    setText(safeProgressSlotText(api, sessionID, props, renderer, maxChars, allowGlobal))
  }
}

function createTextElement(value: TextSource): unknown {
  const node = createElement("text")
  insert(node, value)
  return node
}

function currentProgressModel(api: TuiApi, sessionID?: unknown) {
  const context = currentWorkflowContext(api)
  const progress = context.state ? createNodeProgressStore(context.project).readRun(context.state) : {}
  return progressModel(api, context.state, progress, sessionID)
}

function currentWorkflowContext(api: TuiApi): WorkflowContext {
  const directory = api.state.path.directory
  const direct = readWorkflowState(directory)
  if (direct) return { project: directory, state: direct }

  for (const project of workflowProjectCandidates(directory)) {
    const state = readWorkflowState(project)
    if (state) {
      return {
        project,
        state,
        diagnostic: `SP: using workflow state from ${formatProjectPath(project, directory)}`,
      }
    }
  }

  return {
    project: directory,
    state: null,
    diagnostic: `SP: no workflow state in ${formatProjectPath(directory, directory)}`,
  }
}

function readWorkflowState(project: string): WorkflowState | null {
  if (!existsSync(join(project, ".opencode", "superpowers", "current.json"))) return null
  return createProjectStore(project).readCurrent()
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
) {
  if (typeof sessionID === "string" && state && !isWorkflowSession(state, sessionID)) {
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

function formatSessionStatus(status: { type: string; attempt?: number; message?: string } | undefined): string {
  if (!status) return "unknown"
  if (status.type === "retry") return `retry ${status.attempt ?? "?"}${status.message ? `: ${status.message}` : ""}`
  return status.type
}

function createQuestionBridgePanel(
  api: TuiApi,
  client: QuestionBridgeClient = createHttpQuestionBridgeClient(),
  refreshMs = 1000,
): unknown {
  const [status, setStatus] = createSignal("Loading child questions...")
  const [requests, setRequests] = createSignal<QuestionRequest[]>([])
  const [actions, setActions] = createSignal<QuestionAction[]>([])

  const refresh = async () => {
    try {
      const context = currentWorkflowContext(api)
      const nextRequests = filterWorkflowQuestionRequests(context.state, await client.list(context.project))
      setRequests(nextRequests)
      setActions(buildQuestionActions(nextRequests))
      setStatus(renderQuestionBridgeText(nextRequests))
    } catch (error) {
      setRequests([])
      setActions([])
      setStatus(`Question bridge unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  void refresh()
  const timer = setInterval(() => void refresh(), refreshMs)
  onCleanup(() => clearInterval(timer))

  const root = createElement("box")
  setProp(root, "style", { flexDirection: "column", width: "100%", height: "100%" })

  const body = createElement("text")
  insert(body, status)
  insert(root, body)

  const select = createElement("select")
  setProp(select, "focused", true)
  setProp(select, "showDescription", true)
  setProp(select, "height", 12)
  setProp(select, "onSelect", (_index: number, option: { value?: QuestionAction } | null) => {
    const action = option?.value
    if (action) void submitQuestionAction(client, action, refresh, setStatus)
  })
  createEffect(() => {
    setProp(select, "options", actions().map((action) => ({
      name: action.label,
      description: action.description,
      value: action,
    })))
  })
  insert(root, select)

  const footer = createElement("text")
  insert(footer, () => requests().length > 0 ? "Use arrows to choose an action, Enter to submit." : "")
  insert(root, footer)

  return root
}

async function submitQuestionAction(
  client: QuestionBridgeClient,
  action: QuestionAction,
  refresh: () => Promise<void>,
  setStatus: (value: string) => void,
): Promise<void> {
  setStatus(`${action.label} submitted...`)
  try {
    if (action.type === "reply") {
      await client.reply(action.sessionID, action.requestID, action.answers)
    } else {
      await client.reject(action.sessionID, action.requestID)
    }
    await refresh()
  } catch (error) {
    setStatus(`Question action failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export default createTuiPluginModule()
