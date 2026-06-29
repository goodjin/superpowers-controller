import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRoot, type Accessor } from "solid-js"
import { createNodeProgressStore } from "../src/progress/node-progress"
import { createProjectStore } from "../src/state/store"
import type { WorkflowState } from "../src/state/types"
import { createCompactProgressSlot, createProgressSlot, createTuiPluginModule, RESIDENT_PROGRESS_SLOT_NAMES } from "../src/tui"

describe("Superpowers TUI plugin", () => {
  test("registers the progress route and persistent progress slots", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-tui-plugin-"))
    try {
      const routes: Array<{ name: string; render: () => unknown }> = []
      const commands: Array<{ title: string; value: string; onSelect?: () => void }> = []
      const slots: Record<string, (_context?: unknown, props?: Record<string, unknown>) => unknown> = {}
      const navigated: Array<{ name: string; params?: Record<string, unknown> }> = []
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Ship progress",
        request: "Ship progress",
        proposal: "Show child session progress",
        parentSessionID: "session-main",
      })
      const node = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-child",
        task_id: "T1",
        task_markdown: "Implement task",
      })
      createNodeProgressStore(project).append(state.id, {
        at: new Date().toISOString(),
        kind: "tool_running",
        session_id: "session-child",
        node_id: node.id,
        agent: "sp-implementer",
        phase: "implement",
        task_id: "T1",
        summary: "bash running",
        detail: "bun run test",
      })
      const plugin = createTuiPluginModule()
      const api = {
        route: {
          register(input: Array<{ name: string; render: () => unknown }>) {
            routes.push(...input)
            return () => {}
          },
          navigate(name: string, params?: Record<string, unknown>) {
            navigated.push({ name, params })
          },
        },
        command: {
          register(callback: () => Array<{ title: string; value: string; onSelect?: () => void }>) {
            commands.push(...callback())
            return () => {}
          },
        },
        slots: {
          register(plugin: { slots: Record<string, (_context?: unknown, props?: Record<string, unknown>) => unknown> }) {
            Object.assign(slots, plugin.slots)
            return "superpowers-progress-slots"
          },
        },
        state: {
          path: { directory: project },
          session: {
            status(sessionID: string) {
              expect(sessionID).toBe("session-child")
              return { type: "busy" }
            },
          },
        },
      } as never

      await plugin.tui(
        api,
        undefined,
        { id: "superpowers-controller", source: "file", spec: "", target: "", first_time: 0, last_time: 0, time_changed: 0, load_count: 1, fingerprint: "", state: "first" },
      )

      expect(routes.map((route) => route.name).sort()).toEqual(["superpowers-progress"])
      expect(String(routes[0]?.render())).toContain("Superpowers Progress")
      expect(commands.map((command) => command.value).sort()).toEqual(["superpowers.progress"])
      expect(commands.map((command) => command.value)).not.toContain("superpowers.questions")
      expect(Object.keys(slots).sort()).toEqual([...RESIDENT_PROGRESS_SLOT_NAMES].sort())
      expect(typeof slots.sidebar_footer).toBe("function")
      expect(typeof slots.sidebar_content).toBe("function")
      expect(slots.home_bottom).toBeUndefined()
      expect(typeof slots.app_bottom).toBe("function")
      expect(slots.session_prompt_right).toBeUndefined()
      expect(slots.home_prompt).toBeUndefined()
      expect(slots.home_prompt_right).toBeUndefined()
      expect(slots.app_bottom()).toBeNull()
      const workflowStatusSlot = createProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0, renderer: "workflow-status" },
      )
      expect(workflowStatusSlot()).toBeNull()
      const globalWorkflowStatusSlot = createProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0, renderer: "workflow-status", allowGlobal: true },
      )
      const globalWorkflowStatus = globalWorkflowStatusSlot() as { type: string; value: string }
      expect(globalWorkflowStatus.type).toBe("text")
      expect(globalWorkflowStatus.value).toContain("SP: feature running@implement | tasks 0/1 done | sessions 1 running")
      expect(globalWorkflowStatus.value).toContain("sp-implementer T1 running")
      const sessionWorkflowStatus = workflowStatusSlot(undefined, { session_id: "session-main" }) as { type: string; value: string }
      expect(sessionWorkflowStatus.type).toBe("text")
      expect(sessionWorkflowStatus.value).toContain("SP: feature running@implement | tasks 0/1 done | sessions 1 running")
      expect(sessionWorkflowStatus.value).toContain("sp-implementer T1 running")
      expect(sessionWorkflowStatus.value).toContain("bash running")
      const sidebarSlot = createProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0, renderer: "sidebar", allowGlobal: true },
      )
      const globalSidebar = sidebarSlot() as { type: string; value: string }
      expect(globalSidebar.type).toBe("text")
      expect(globalSidebar.value).toContain("SP: feature running@implement | tasks 0/1 done | sessions 1 running")
      expect(globalSidebar.value).toContain("sp-implementer T1: running - bash running")
      expect(globalSidebar.value).toContain("bun run test")
      const sessionSidebar = sidebarSlot(undefined, { session_id: "session-main" }) as { type: string; value: string }
      expect(sessionSidebar.type).toBe("text")
      expect(sessionSidebar.value).toContain("SP: feature running@implement | tasks 0/1 done | sessions 1 running")
      expect(sessionSidebar.value).toContain("sp-implementer T1: running - bash running")
      expect(sessionSidebar.value).toContain("bun run test")
      const compactSlot = createCompactProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0 },
      )
      expect(compactSlot()).toEqual({
        type: "text",
        value: "SP: sp-implementer T1 running - bash running",
      })
      expect(compactSlot(undefined, { session_id: "session-main" })).toEqual({
        type: "text",
        value: "SP: sp-implementer T1 running - bash running",
      })
      expect(compactSlot(undefined, { session_id: "session-child" })).toEqual({
        type: "text",
        value: "SP: sp-implementer T1 running - bash running",
      })
      expect(compactSlot(undefined, { sessionID: "session-main" })).toEqual({
        type: "text",
        value: "SP: sp-implementer T1 running - bash running",
      })
      expect(compactSlot(undefined, { session_id: "session-other" })).toBeNull()
      const promptFallbackSlot = createCompactProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0, maxChars: 44 },
      )
      expect(promptFallbackSlot()).toEqual({
        type: "text",
        value: "SP: sp-implementer T1 running - bash running",
      })
      commands.find((command) => command.value === "superpowers.progress")?.onSelect?.()
      expect(navigated).toEqual([{ name: "superpowers-progress", params: undefined }])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("resolves workflow progress from the configured Superagent project directory", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-tui-project-"))
    const tuiDirectory = mkdtempSync(join(tmpdir(), "sp-tui-directory-"))
    const previousProject = process.env.SUPERAGENT_PROJECT_DIR
    try {
      process.env.SUPERAGENT_PROJECT_DIR = project
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Ship fallback progress",
        request: "Ship fallback progress",
        proposal: "Show progress from configured project",
        parentSessionID: "session-main",
      })
      const node = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-child",
        task_id: "T1",
        task_markdown: "Implement task",
      })
      createNodeProgressStore(project).append(state.id, {
        at: new Date().toISOString(),
        kind: "text",
        session_id: "session-child",
        node_id: node.id,
        agent: "sp-implementer",
        phase: "implement",
        task_id: "T1",
        summary: "assistant text updated",
        detail: "Working from the configured project",
      })
      const api = {
        state: {
          path: { directory: tuiDirectory },
          session: {
            status(sessionID: string) {
              expect(sessionID).toBe("session-child")
              return { type: "busy" }
            },
          },
        },
      } as never
      const compactSlot = createCompactProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0 },
      )

      expect(compactSlot()).toEqual({
        type: "text",
        value: "SP: sp-implementer T1 running - assistant text updated",
      })
    } finally {
      if (previousProject === undefined) {
        delete process.env.SUPERAGENT_PROJECT_DIR
      } else {
        process.env.SUPERAGENT_PROJECT_DIR = previousProject
      }
      rmSync(project, { recursive: true, force: true })
      rmSync(tuiDirectory, { recursive: true, force: true })
    }
  })

  test("global progress slots prefer the latest unfinished workflow across fallback projects", () => {
    const oldProject = mkdtempSync(join(tmpdir(), "sp-tui-old-project-"))
    const currentProject = mkdtempSync(join(tmpdir(), "sp-tui-current-project-"))
    const tuiDirectory = mkdtempSync(join(tmpdir(), "sp-tui-directory-"))
    const previousSuperagentProject = process.env.SUPERAGENT_PROJECT_DIR
    const previousOpencodeProject = process.env.OPENCODE_SUPERPOWERS_PROJECT_DIR
    try {
      process.env.SUPERAGENT_PROJECT_DIR = oldProject
      process.env.OPENCODE_SUPERPOWERS_PROJECT_DIR = currentProject
      createWorkflowWithProgress({
        project: oldProject,
        parentSessionID: "session-old-main",
        childSessionID: "session-old-child",
        summary: "old workflow progress",
        updatedAt: "2026-06-26T01:00:00.000Z",
      })
      createWorkflowWithProgress({
        project: currentProject,
        parentSessionID: "session-current-main",
        childSessionID: "session-current-child",
        summary: "current workflow progress",
        updatedAt: "2026-06-26T02:00:00.000Z",
      })
      const api = {
        state: {
          path: { directory: tuiDirectory },
          session: {
            status() {
              return { type: "busy" }
            },
          },
        },
      } as never
      const compactSlot = createCompactProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0 },
      )

      expect(compactSlot()).toEqual({
        type: "text",
        value: "SP: sp-implementer T1 running - current workflow progress",
      })
    } finally {
      restoreEnv("SUPERAGENT_PROJECT_DIR", previousSuperagentProject)
      restoreEnv("OPENCODE_SUPERPOWERS_PROJECT_DIR", previousOpencodeProject)
      rmSync(oldProject, { recursive: true, force: true })
      rmSync(currentProject, { recursive: true, force: true })
      rmSync(tuiDirectory, { recursive: true, force: true })
    }
  })

  test("session slots prefer the workflow that owns the rendered session", () => {
    const newerUnrelatedProject = mkdtempSync(join(tmpdir(), "sp-tui-newer-unrelated-"))
    const sessionProject = mkdtempSync(join(tmpdir(), "sp-tui-session-project-"))
    const tuiDirectory = mkdtempSync(join(tmpdir(), "sp-tui-directory-"))
    const previousSuperagentProject = process.env.SUPERAGENT_PROJECT_DIR
    const previousOpencodeProject = process.env.OPENCODE_SUPERPOWERS_PROJECT_DIR
    try {
      process.env.SUPERAGENT_PROJECT_DIR = newerUnrelatedProject
      process.env.OPENCODE_SUPERPOWERS_PROJECT_DIR = sessionProject
      createWorkflowWithProgress({
        project: newerUnrelatedProject,
        parentSessionID: "session-unrelated-main",
        childSessionID: "session-unrelated-child",
        summary: "newer unrelated progress",
        updatedAt: "2026-06-26T03:00:00.000Z",
      })
      createWorkflowWithProgress({
        project: sessionProject,
        parentSessionID: "session-current-main",
        childSessionID: "session-current-child",
        summary: "session owned progress",
        updatedAt: "2026-06-26T02:00:00.000Z",
      })
      const api = {
        state: {
          path: { directory: tuiDirectory },
          session: {
            status() {
              return { type: "busy" }
            },
          },
        },
      } as never
      const sidebarSlot = createProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0, renderer: "sidebar", allowGlobal: true },
      )

      for (const rendered of [
        sidebarSlot(undefined, { session_id: "session-current-main" }),
        sidebarSlot({ session_id: "session-current-main" }),
        sidebarSlot({ session: { id: "session-current-main" } }),
      ] as Array<{ type: string; value: string }>) {
        expect(rendered.type).toBe("text")
        expect(rendered.value).toContain("SP: feature running@implement | tasks 0/1 done | sessions 1 running")
        expect(rendered.value).toContain("sp-implementer T1 running - session owned progress")
        expect(rendered.value).toContain("sp-implementer T1: running - session owned progress")
      }
      expect(sidebarSlot(undefined, { session_id: "session-other" })).toBeNull()
    } finally {
      restoreEnv("SUPERAGENT_PROJECT_DIR", previousSuperagentProject)
      restoreEnv("OPENCODE_SUPERPOWERS_PROJECT_DIR", previousOpencodeProject)
      rmSync(newerUnrelatedProject, { recursive: true, force: true })
      rmSync(sessionProject, { recursive: true, force: true })
      rmSync(tuiDirectory, { recursive: true, force: true })
    }
  })

  test("sidebar content shows active workflow progress for a new controller session", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-tui-controller-session-"))
    try {
      createWorkflowWithProgress({
        project,
        parentSessionID: "session-old-controller",
        childSessionID: "session-child",
        summary: "controller fallback progress",
        updatedAt: "2026-06-30T02:00:00.000Z",
      })
      const api = {
        state: {
          path: { directory: project },
          session: {
            status() {
              return { type: "busy" }
            },
          },
        },
      } as never
      const sidebarSlot = createProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0, renderer: "sidebar", allowGlobal: true },
      )

      const controllerSidebar = sidebarSlot({ session: { id: "session-new-controller", agent: "super-agent" } }) as { type: string; value: string }
      expect(controllerSidebar.type).toBe("text")
      expect(controllerSidebar.value).toContain("SP: feature running@implement | tasks 0/1 done | sessions 1 running")
      expect(controllerSidebar.value).toContain("sp-implementer T1: running - controller fallback progress")
      expect(sidebarSlot({ session: { id: "session-other", agent: "sp-implementer" } })).toBeNull()
      expect(sidebarSlot(undefined, { session_id: "session-other" })).toBeNull()
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("resident progress slots refresh progress files after initial render", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-tui-refresh-"))
    try {
      const state = createWorkflowWithProgress({
        project,
        parentSessionID: "session-main",
        childSessionID: "session-child",
        summary: "initial progress",
        updatedAt: "2026-06-26T02:00:00.000Z",
      })
      const node = state.node_runs[0]
      if (!node) throw new Error("expected node")
      const api = {
        state: {
          path: { directory: project },
          session: {
            status() {
              return { type: "busy" }
            },
          },
        },
      } as never
      let text: Accessor<string> | undefined

      await new Promise<void>((resolve, reject) => {
        createRoot((dispose) => {
          try {
            const slot = createProgressSlot(
              api,
              (value) => {
                text = typeof value === "function" ? value : () => value
                return { type: "text" }
              },
              { refreshMs: 5, renderer: "sidebar", allowGlobal: true },
            )
            slot(undefined, { session_id: "session-main" })
            expect(text?.()).toContain("initial progress")
            createNodeProgressStore(project).append(state.id, {
              at: "2026-06-26T02:00:05.000Z",
              kind: "tool_running",
              session_id: "session-child",
              node_id: node.id,
              agent: node.agent,
              phase: node.phase,
              task_id: node.task_id,
              summary: "refreshed progress",
            })
            setTimeout(() => {
              try {
                expect(text?.()).toContain("refreshed progress")
                dispose()
                resolve()
              } catch (error) {
                dispose()
                reject(error)
              }
            }, 20)
          } catch (error) {
            dispose()
            reject(error)
          }
        })
      })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

function createWorkflowWithProgress(args: {
  project: string
  parentSessionID: string
  childSessionID: string
  summary: string
  updatedAt: string
}): WorkflowState {
  const store = createProjectStore(args.project)
  const state = store.startRun({
    workflow: "feature",
    entrypoint: "execute",
    goal: args.summary,
    request: args.summary,
    proposal: args.summary,
    parentSessionID: args.parentSessionID,
  })
  const node = store.addNodeRun({
    phase: "implement",
    agent: "sp-implementer",
    session_id: args.childSessionID,
    task_id: "T1",
    task_markdown: args.summary,
  })
  createNodeProgressStore(args.project).append(state.id, {
    at: new Date().toISOString(),
    kind: "text",
    session_id: args.childSessionID,
    node_id: node.id,
    agent: "sp-implementer",
    phase: "implement",
    task_id: "T1",
    summary: args.summary,
  })
  const current = store.readCurrent()
  if (!current) throw new Error("expected workflow state")
  const updated = { ...current, updated_at: args.updatedAt }
  writeWorkflowState(args.project, updated)
  return updated
}

function writeWorkflowState(project: string, state: WorkflowState): void {
  writeFileSync(
    join(project, ".opencode", "superpowers", "runs", state.id, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  )
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
