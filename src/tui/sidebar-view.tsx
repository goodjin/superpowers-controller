/** @jsxImportSource @opentui/solid */
import { For, Show, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { SidebarHostModel, SidebarSessionRow, SidebarViewModel } from "./sidebar-model"
import { renderSidebarViewModelText } from "./sidebar-model"
import { logSidebarDiag, summarizeSidebarModel } from "./sidebar-debug"

export type SidebarTheme = {
  text?: string
  textMuted?: string
  warning?: string
  success?: string
  info?: string
}

export type SidebarViewApi = {
  theme?: {
    current: SidebarTheme
  }
  event?: {
    on(type: string, handler: () => void): (() => void) | void
  }
}

export type SidebarViewProps = {
  api: SidebarViewApi
  sessionID?: string
  allowGlobal?: boolean
  refreshMs?: number
  buildModel: () => SidebarViewModel
  loadModel?: () => Promise<SidebarViewModel>
  onEventTypes?: string[]
  debug?: boolean
}

/** Return a Solid element tree for the host slot runtime (do not call SidebarView() directly). */
export function renderSidebarSlotView(props: SidebarViewProps) {
  return <SidebarView {...props} />
}

export function SidebarView(props: SidebarViewProps) {
  const refreshMs = props.refreshMs ?? 1000
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((value) => value + 1)
  const model = createMemo(() => {
    version()
    try {
      const next = props.buildModel()
      if (props.debug) logSidebarDiag("jsx_model", summarizeSidebarModel(next))
      return next
    } catch (error) {
      logSidebarDiag("jsx_model_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      return fallbackModel()
    }
  })

  const scheduleAsyncRefresh = () => {
    if (!props.loadModel) return
    void props.loadModel()
      .then(() => bump())
      .catch(() => bump())
  }

  if (refreshMs > 0) {
    const timer = setInterval(() => {
      bump()
      scheduleAsyncRefresh()
    }, refreshMs)
    const initialDeferred = setTimeout(scheduleAsyncRefresh, 250)
    const eventDisposers = registerRefreshEvents(props.api, props.onEventTypes ?? [], () => {
      bump()
      scheduleAsyncRefresh()
    })
    onCleanup(() => {
      clearInterval(timer)
      clearTimeout(initialDeferred)
      for (const dispose of eventDisposers) dispose()
    })
  }

  return <SidebarViewContent api={props.api} model={model} debug={props.debug} />
}

export function SidebarViewContent(props: {
  api: SidebarViewApi
  model: Accessor<SidebarViewModel>
  debug?: boolean
}) {
  const theme = () => props.api.theme?.current ?? {}
  const workflowLines = createMemo(() => props.model().workflowLines)
  const host = createMemo(() => props.model().host)
  const view = createMemo(() => props.model())

  return (
    <box style={{ flexDirection: "column" }}>
      <Show when={workflowLines().length > 0}>
        <For each={workflowLines()}>
          {(line) => <SidebarText theme={theme()} value={line} tone="text" />}
        </For>
      </Show>
      <Show when={workflowLines().length === 0 && view().hasWorkflow}>
        <SidebarText theme={theme()} value="SP: workflow active" tone="muted" />
      </Show>
      <Show when={workflowLines().length === 0 && !view().hasWorkflow && view().hostMode !== "single-focus"}>
        <SidebarText theme={theme()} value="Superpowers workflow" tone="muted" />
        <SidebarText theme={theme()} value="not started" tone="muted" />
      </Show>
      <Show when={view().workflowDiagnostic}>
        <SidebarText theme={theme()} value={view().workflowDiagnostic!} tone="warning" />
      </Show>
      <SidebarHostSection api={props.api} host={host()} />
      <Show when={view().placeholder && shouldShowPlaceholder(view())}>
        <SidebarText theme={theme()} value={view().placeholder!} tone="muted" />
      </Show>
      <Show when={props.debug}>
        <SidebarText
          theme={theme()}
          value={`[sp-dbg] ${view().hostMode} ${view().host.kind}`}
          tone="info"
        />
      </Show>
    </box>
  )
}

function SidebarHostSection(props: { api: SidebarViewApi; host: SidebarHostModel }) {
  const theme = () => props.api.theme?.current ?? {}
  switch (props.host.kind) {
    case "single-focus":
      return (
        <box style={{ flexDirection: "column" }}>
          <SidebarText theme={theme()} value="Session" tone="muted" />
          <box style={{ flexDirection: "row" }}>
            <SidebarText theme={theme()} value={activityMarker(props.host.activity)} tone="warning" />
            <SidebarText theme={theme()} value={displayActivity(props.host.activity)} tone="warning" />
          </box>
          <SidebarText theme={theme()} value={props.host.title} tone="text" />
          <Show when={props.host.detail}>
            <SidebarText theme={theme()} value={props.host.detail!} tone="muted" />
          </Show>
        </box>
      )
    case "session-list":
      return (
        <box style={{ flexDirection: "column" }}>
          <SidebarText theme={theme()} value={props.host.heading} tone="muted" />
          <SidebarText theme={theme()} value={props.host.summary} tone="muted" />
          <For each={props.host.rows}>
            {(row) => <SessionListRow api={props.api} row={row} />}
          </For>
          <Show when={props.host.moreCount && props.host.moreCount > 0}>
            <SidebarText theme={theme()} value={`+${props.host.moreCount} more`} tone="muted" />
          </Show>
        </box>
      )
    case "message":
      return (
        <box style={{ flexDirection: "column" }}>
          <For each={props.host.lines}>
            {(line) => <SidebarText theme={theme()} value={line} tone="muted" />}
          </For>
        </box>
      )
  }
}

function SessionListRow(props: { api: SidebarViewApi; row: SidebarSessionRow }) {
  const theme = () => props.api.theme?.current ?? {}
  const summary = () => props.row.activity || `${props.row.status} - ${props.row.title}`
  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row" }}>
        <SidebarText theme={theme()} value={`${props.row.marker} `} tone={props.row.active ? "warning" : "muted"} />
        <Show when={props.row.shortcut}>
          <SidebarText theme={theme()} value={props.row.shortcut} tone="info" />
        </Show>
        <SidebarText
          theme={theme()}
          value={`${props.row.agent}${props.row.parentSuffix}: ${summary()}`}
          tone="text"
        />
      </box>
      <Show when={props.row.activity && props.row.title}>
        <SidebarText theme={theme()} value={props.row.title} tone="muted" />
      </Show>
    </box>
  )
}

function SidebarText(props: {
  theme: SidebarTheme
  value: string
  tone: "text" | "muted" | "warning" | "info"
}) {
  const color = () => {
    switch (props.tone) {
      case "warning":
        return props.theme.warning
      case "info":
        return props.theme.info
      case "muted":
        return props.theme.textMuted
      default:
        return props.theme.text
    }
  }
  const style = createMemo(() => {
    const fg = color()
    return fg ? { fg } : undefined
  })
  return (
    <text style={style()}>{props.value}</text>
  )
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

export function sidebarViewModelFallbackText(model?: SidebarViewModel): string {
  if (!model) return "SP: progress unavailable"
  return renderSidebarViewModelText(model)
}

function shouldShowPlaceholder(model: SidebarViewModel): boolean {
  if (!model.placeholder) return false
  const hasWorkflow = model.workflowLines.length > 0 || model.hasWorkflow
  const hasHost = model.host.kind === "message"
    ? model.host.lines.length > 0
    : model.host.kind === "single-focus"
      || model.host.rows.length > 0
  return !hasWorkflow && !hasHost
}

function fallbackModel(): SidebarViewModel {
  return {
    hasWorkflow: false,
    hostMode: "overview",
    workflowLines: [],
    host: { kind: "message", lines: ["SP: progress unavailable"] },
  }
}

function registerRefreshEvents(
  api: SidebarViewApi,
  extraTypes: string[],
  refresh: () => void,
): Array<() => void> {
  if (!api.event?.on) return []
  const types = [...new Set([
    ...extraTypes,
    "message.part.updated",
    "message.part.delta",
    "message.part.added",
    "session.status",
    "session.idle",
    "session.updated",
  ])]
  const disposers: Array<() => void> = []
  for (const type of types) {
    const dispose = api.event.on(type, refresh)
    if (typeof dispose === "function") disposers.push(dispose)
  }
  return disposers
}
