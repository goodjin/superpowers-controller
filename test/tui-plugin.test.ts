import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNodeProgressStore } from "../src/progress/node-progress"
import { createProjectStore } from "../src/state/store"
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

      expect(routes.map((route) => route.name).sort()).toEqual(["superpowers-progress", "superpowers-questions"])
      expect(String(routes[0]?.render())).toContain("Superpowers Progress")
      expect(commands.map((command) => command.value).sort()).toEqual(["superpowers.progress", "superpowers.questions"])
      expect(Object.keys(slots).sort()).toEqual([...RESIDENT_PROGRESS_SLOT_NAMES].sort())
      expect(typeof slots.sidebar_footer).toBe("function")
      expect(typeof slots.sidebar_content).toBe("function")
      expect(slots.home_bottom).toBeUndefined()
      expect(typeof slots.app_bottom).toBe("function")
      expect(typeof slots.session_prompt_right).toBe("function")
      expect(slots.home_prompt).toBeUndefined()
      expect(slots.home_prompt_right).toBeUndefined()
      const workflowStatusSlot = createProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0, renderer: "workflow-status" },
      )
      expect(workflowStatusSlot()).toBeNull()
      expect(workflowStatusSlot(undefined, { session_id: "session-main" })).toEqual({
        type: "text",
        value: "SP: feature running@implement | tasks 0/1 done | sessions 1 running",
      })
      const sidebarSlot = createProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0, renderer: "sidebar", allowGlobal: true },
      )
      expect(sidebarSlot()).toEqual({
        type: "text",
        value: "SP: feature running@implement | tasks 0/1 done | sessions 1 running\nrunning\nsp-implementer T1: running/busy - bash running",
      })
      expect(sidebarSlot(undefined, { session_id: "session-main" })).toEqual({
        type: "text",
        value: "SP: feature running@implement | tasks 0/1 done | sessions 1 running\nrunning\nsp-implementer T1: running/busy - bash running",
      })
      const compactSlot = createCompactProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0 },
      )
      expect(compactSlot()).toEqual({
        type: "text",
        value: "SP: sp-implementer T1 running/busy - bash running",
      })
      expect(compactSlot(undefined, { session_id: "session-main" })).toEqual({
        type: "text",
        value: "SP: sp-implementer T1 running/busy - bash running",
      })
      expect(compactSlot(undefined, { session_id: "session-child" })).toEqual({
        type: "text",
        value: "SP: sp-implementer T1 running/busy - bash running",
      })
      expect(compactSlot(undefined, { sessionID: "session-main" })).toEqual({
        type: "text",
        value: "SP: sp-implementer T1 running/busy - bash running",
      })
      expect(compactSlot(undefined, { session_id: "session-other" })).toBeNull()
      const promptFallbackSlot = createCompactProgressSlot(
        api,
        (value) => ({ type: "text", value: typeof value === "function" ? value() : value }),
        { refreshMs: 0, maxChars: 44 },
      )
      expect(promptFallbackSlot()).toEqual({
        type: "text",
        value: "SP: sp-implementer T1 running/busy - bash...",
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
        value: "SP: sp-implementer T1 running/busy - assistant text updated",
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
})
