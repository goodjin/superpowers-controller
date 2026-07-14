import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPluginModule } from "../src/plugin"
import { createNodeProgressStore } from "../src/progress/node-progress"
import { createProjectStore } from "../src/state/store"

describe("plugin event progress hook", () => {
  test("records child session events for active node runs", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-plugin-event-progress-"))
    try {
      const workflow = createProjectStore(project)
      workflow.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Implement task",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      workflow.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-child",
        task_id: "T1",
        task_markdown: "# Task",
      })
      const run = workflow.readCurrent()
      if (!run) throw new Error("missing state")

      const plugin = createPluginModule()
      const hooks = await plugin.server({
        directory: project,
        worktree: project,
        project: { id: "project-1" },
        serverUrl: new URL("http://127.0.0.1:4096"),
        $: {},
        experimental_workspace: { register() {} },
        client: {
          session: {},
          tui: { async showToast() {} },
          app: { async log() {} },
        },
      } as never)

      expect(typeof hooks.event).toBe("function")
      await hooks.event?.({
        event: {
          type: "session.status",
          properties: {
            sessionID: "session-child",
            status: { type: "busy" },
          },
        },
      })

      expect(createNodeProgressStore(project).readNode(run.id, "001-implement-T1")).toMatchObject([
        {
          kind: "session_status",
          session_id: "session-child",
          summary: "session busy",
        },
      ])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("selects a child session when it starts waiting on permission in legacy mode", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-plugin-event-permission-"))
    try {
      writeInteractionConfig(project, "legacy")
      const workflow = createProjectStore(project)
      workflow.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Implement task",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      workflow.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-child",
        task_id: "T1",
        task_markdown: "# Task",
      })

      const selected: unknown[] = []
      const toasts: unknown[] = []
      const plugin = createPluginModule()
      const hooks = await plugin.server({
        directory: project,
        worktree: project,
        project: { id: "project-1" },
        serverUrl: new URL("http://127.0.0.1:4096"),
        $: {},
        experimental_workspace: { register() {} },
        client: {
          session: {},
          tui: {
            async selectSession(input: unknown) {
              selected.push(input)
            },
            async showToast(input: unknown) {
              toasts.push(input)
            },
          },
          app: { async log() {} },
        },
      } as never)

      await hooks.event?.({
        event: {
          type: "session.status",
          properties: {
            sessionID: "session-child",
            status: { type: "waiting_permission" },
          },
        },
      })

      expect(selected).toEqual([{ sessionID: "session-child" }])
      expect(toasts[0]).toMatchObject({
        body: {
          stage: "child_waiting_permission",
          variant: "warning",
        },
      })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("does not select a child session on permission in native mode", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-plugin-event-permission-native-"))
    try {
      writeInteractionConfig(project, "native")
      const workflow = createProjectStore(project)
      workflow.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Implement task",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      workflow.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-child",
        task_id: "T1",
        task_markdown: "# Task",
      })

      const selected: unknown[] = []
      const plugin = createPluginModule()
      const hooks = await plugin.server({
        directory: project,
        worktree: project,
        project: { id: "project-1" },
        serverUrl: new URL("http://127.0.0.1:4096"),
        $: {},
        experimental_workspace: { register() {} },
        client: {
          session: {},
          tui: {
            async selectSession(input: unknown) {
              selected.push(input)
            },
            async showToast() {},
          },
          app: { async log() {} },
        },
      } as never)

      await hooks.event?.({
        event: {
          type: "session.status",
          properties: {
            sessionID: "session-child",
            status: { type: "waiting_permission" },
          },
        },
      })

      expect(selected).toEqual([])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

function writeInteractionConfig(project: string, mode: "legacy" | "native" | "hybrid"): void {
  const configDir = join(project, ".opencode")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, "superpowers.jsonc"), JSON.stringify({ interaction: { mode } }, null, 2))
}
