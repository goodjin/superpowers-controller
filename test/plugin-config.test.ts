import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPluginModule } from "../src/plugin"
import { createProjectStore } from "../src/state/store"

describe("plugin config and runtime injection", () => {
  test("Superpowers agent definitions override same-name external agents", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-plugin-config-"))
    try {
      const hooks = await createHooks(project)
      const hostConfig: Record<string, unknown> = {
        permission: "allow",
        agent: {
          "superpowers-agent": {
            permission: "*",
            tools: { skill: true, task: true },
            prompt: "external conflicting controller",
          },
        },
      }

      await hooks.config?.(hostConfig)

      const agent = (hostConfig.agent as Record<string, Record<string, unknown>>)["superpowers-agent"]
      expect(agent.prompt).not.toBe("external conflicting controller")
      expect((agent.tools as { skill?: boolean; task?: boolean }).skill).toBe(false)
      expect((agent.tools as { skill?: boolean; task?: boolean }).task).toBe(false)
      expect((agent.permission as { skill?: string; task?: string }).skill).toBe("deny")
      expect((agent.permission as { skill?: string; task?: string }).task).toBe("deny")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("node agents allow bash after workflow confirmation while keeping control-plane restrictions", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-plugin-node-permission-"))
    try {
      const hooks = await createHooks(project)
      const hostConfig: Record<string, unknown> = {}

      await hooks.config?.(hostConfig)

      const agent = (hostConfig.agent as Record<string, Record<string, unknown>>)["sp-planner"]
      const permission = agent.permission as Record<string, unknown>
      expect(permission.bash).toBe("allow")
      expect(permission.edit).toBe("ask")
      expect(permission.task).toBe("deny")
      expect(permission.question).toBe("deny")
      expect((permission.skill as Record<string, unknown>)["superpowers-writing-plans"]).toBe("allow")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("runtime primary-skill context is injected only into registered node sessions", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-plugin-runtime-injection-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Design feature",
        request: "Design feature",
        proposal: "Design feature",
        parentSessionID: "session-controller",
      })
      store.addNodeRun({
        phase: "design",
        agent: "sp-designer",
        primary_skill: "superpowers-brainstorming",
        session_id: "session-child",
        task_markdown: "# Design",
      })

      const hooks = await createHooks(project)
      const parentOutput = { system: [] as string[] }
      const childOutput = { system: [] as string[] }

      await hooks["experimental.chat.system.transform"]?.({
        sessionID: "session-controller",
        model: {} as never,
      }, parentOutput)
      await hooks["experimental.chat.system.transform"]?.({
        sessionID: "session-child",
        model: {} as never,
      }, childOutput)

      expect(parentOutput.system).toEqual([])
      expect(childOutput.system.join("\n")).toContain("agent: sp-designer")
      expect(childOutput.system.join("\n")).toContain("primary_skill: superpowers-brainstorming")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("plugin startup logs timing checkpoints", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-plugin-startup-timing-"))
    const logs: string[] = []
    try {
      const plugin = createPluginModule()
      await plugin.server({
        directory: project,
        worktree: project,
        project: { id: "project-1" },
        serverUrl: new URL("http://127.0.0.1:4096"),
        $: {},
        experimental_workspace: { register() {} },
        client: {
          session: {},
          tui: { async showToast() {} },
          app: {
            async log(input: { body?: { message?: string } }) {
              if (input.body?.message) logs.push(input.body.message)
            },
          },
        },
      } as never)

      expect(logs).toContainEqual(expect.stringContaining("[timing] startup config load:"))
      expect(logs).toContainEqual(expect.stringContaining("[timing] startup store init:"))
      expect(logs).toContainEqual(expect.stringContaining("[timing] startup startup recovery:"))
      expect(logs).toContainEqual(expect.stringContaining("[timing] startup runtime wiring:"))
      expect(logs).toContainEqual(expect.stringContaining("[timing] startup total:"))
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

async function createHooks(project: string) {
  const plugin = createPluginModule()
  return plugin.server({
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
}
