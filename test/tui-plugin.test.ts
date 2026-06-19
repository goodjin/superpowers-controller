import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNodeProgressStore } from "../src/progress/node-progress"
import { createProjectStore } from "../src/state/store"
import { createTuiPluginModule } from "../src/tui"

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
        at: "2026-06-19T00:01:00.000Z",
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

      await plugin.tui(
        {
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
        } as never,
        undefined,
        { id: "superpowers-controller", source: "file", spec: "", target: "", first_time: 0, last_time: 0, time_changed: 0, load_count: 1, fingerprint: "", state: "first" },
      )

      expect(routes.map((route) => route.name)).toContain("superpowers-progress")
      expect(String(routes[0]?.render())).toContain("Superpowers Progress")
      expect(commands.map((command) => command.value)).toContain("superpowers.progress")
      expect(Object.keys(slots).sort()).toEqual(["session_prompt_right", "sidebar_footer"])
      expect(String(slots.session_prompt_right?.(undefined, { session_id: "session-main" }))).toContain("SP: sp-implementer T1 running/busy - bash running")
      expect(String(slots.sidebar_footer?.(undefined, { session_id: "session-main" }))).toContain("SP: sp-implementer T1 running/busy - bash running")
      expect(String(slots.session_prompt_right?.(undefined, { session_id: "session-child" }))).toBe("")
      commands.find((command) => command.value === "superpowers.progress")?.onSelect?.()
      expect(navigated).toEqual([{ name: "superpowers-progress", params: undefined }])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
