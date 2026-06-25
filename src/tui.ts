import "@opentui/solid/runtime-plugin-support"
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
  "session_prompt_right",
  "sidebar_footer",
  "sidebar_content",
  "app_bottom",
] as const

type ProgressSlotRenderer = "compact" | "workflow-status" | "running-sessions" | "sidebar"

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
            const state = currentWorkflowState(api)
            const progress = state ? createNodeProgressStore(api.state.path.directory).readRun(state) : {}
            return renderProgressPanelText(
              buildProgressPanelViewModel(state, progress, liveStatusBySession(api, state)),
            )
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
      return { renderer: "workflow-status", maxChars: 100 }
    case "sidebar_content":
      return { renderer: "sidebar", allowGlobal: true }
    case "session_prompt_right":
      return { renderer: "compact", maxChars: 80 }
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
    const state = currentWorkflowState(api)
    const progress = state ? createNodeProgressStore(api.state.path.directory).readRun(state) : {}
    const model = progressModel(api, state, progress, sessionID)
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
    const state = currentWorkflowState(api)
    const questions = filterWorkflowQuestionRequests(state, await client.list(api.state.path.directory))
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
  const state = currentWorkflowState(api)
  const progress = state ? createNodeProgressStore(api.state.path.directory).readRun(state) : {}
  return progressModel(api, state, progress, sessionID)
}

function currentWorkflowState(api: TuiApi): WorkflowState | null {
  const workflow = createProjectStore(api.state.path.directory)
  return workflow.readCurrent()
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
      const state = currentWorkflowState(api)
      const nextRequests = filterWorkflowQuestionRequests(state, await client.list(api.state.path.directory))
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
