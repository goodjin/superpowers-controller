import { describe, expect, test } from "bun:test"
import {
  collectSeedSessionIDs,
  collectWorkflowSessionIDs,
  combineSidebarContentText,
  isActiveHostSessionStatus,
  loadHostSessions,
  readHostSessionsSync,
  renderHostSessionsOverview,
  renderSingleSessionFocus,
  renderWorkflowSessionsList,
  resolveSidebarHostRenderMode,
} from "../src/tui/host-sessions"

describe("host sessions overview", () => {
  test("resolveSidebarHostRenderMode picks single focus for one active session", () => {
    expect(resolveSidebarHostRenderMode(false, [
      { id: "a", title: "A", agent: "build", live_status: "busy", active: true, updated_at: 1 },
      { id: "b", title: "B", agent: "build", live_status: "idle", active: false, updated_at: 2 },
    ])).toBe("single-focus")
    expect(resolveSidebarHostRenderMode(true, [])).toBe("workflow-list")
    expect(resolveSidebarHostRenderMode(false, [
      { id: "a", title: "A", agent: "build", live_status: "busy", active: true, updated_at: 1 },
      { id: "b", title: "B", agent: "build", live_status: "busy", active: true, updated_at: 2 },
    ])).toBe("overview")
  })

  test("collects workflow session ids from current state only", () => {
    const ids = collectWorkflowSessionIDs({
      parent_session_id: "parent-1",
      session: "parent-1",
      node_runs: [{ session_id: "child-1" }, { session_id: "child-2" }],
    }, "route-session")
    expect(ids.sort()).toEqual(["child-1", "child-2", "parent-1", "route-session"].sort())
  })

  test("combines workflow progress before host overview", () => {
    const text = combineSidebarContentText({
      hostOverview: "OpenCode sessions\ntotal 58 | running 1",
      workflowText: "SP: orchestration running@implement\nchild sessions\nsp-implementer: running",
      hasWorkflow: true,
    })
    expect(text.indexOf("child sessions")).toBeLessThan(text.indexOf("OpenCode sessions"))
  })

  test("collects seed session ids from workflow candidates", () => {
    const ids = collectSeedSessionIDs([
      {
        state: {
          parent_session_id: "parent-1",
          session: "parent-1",
          node_runs: [{ session_id: "child-1" }, { session_id: "child-2" }],
        },
      },
    ], "route-session")
    expect(ids.sort()).toEqual(["child-1", "child-2", "parent-1", "route-session"].sort())
  })

  test("renders workflow session list with running markers", () => {
    const text = renderWorkflowSessionsList([
      {
        id: "idle",
        title: "Controller",
        agent: "superpowers-agent",
        live_status: "idle",
        active: false,
        updated_at: 10,
      },
      {
        id: "busy",
        title: "Implement task",
        agent: "sp-implementer",
        parent_id: "idle",
        live_status: "busy",
        active: true,
        updated_at: 20,
      },
    ])
    expect(text).toContain("Sessions")
    expect(text).toContain("total 2 | running 1")
    expect(text).toContain("● sp-implementer child: busy - Implement task")
    expect(text).toContain("  superpowers-agent: idle - Controller")
  })

  test("renders single running session with title and tool action", () => {
    const api = {
      state: {
        path: { directory: "/tmp/project" },
        session: {
          status() {
            return { type: "busy" }
          },
          messages() {
            return [{
              info: { id: "msg-1", role: "assistant" },
              parts: [{
                type: "tool",
                tool: "edit",
                state: { status: "running", title: "src/tui.ts" },
              }],
            }]
          },
        },
      },
    }
    const text = renderSingleSessionFocus(api, {
      id: "session-1",
      title: "Fix sidebar layout",
      agent: "build",
      live_status: "busy",
      active: true,
      updated_at: 1,
    })
    expect(text).toBe("Fix sidebar layout — calling Edit src/tui.ts")
  })

  test("renders single running session as thinking when no tool activity", () => {
    const api = {
      state: {
        path: { directory: "/tmp/project" },
        session: {
          status() {
            return { type: "busy" }
          },
          messages() {
            return [{
              info: { id: "msg-1", role: "assistant" },
              parts: [{ type: "reasoning", text: "planning next step" }],
            }]
          },
        },
      },
    }
    const text = renderSingleSessionFocus(api, {
      id: "session-1",
      title: "Plan feature",
      agent: "build",
      live_status: "busy",
      active: true,
      updated_at: 1,
    })
    expect(text).toBe("Plan feature — thinking…\nthinking: planning next step")
  })

  test("single-focus mode skips workflow-not-started banner", () => {
    const text = combineSidebarContentText({
      hostOverview: "Fix sidebar layout — calling Edit src/tui.ts",
      workflowText: "",
      hasWorkflow: false,
      hostMode: "single-focus",
    })
    expect(text).toBe("Fix sidebar layout — calling Edit src/tui.ts")
    expect(text).not.toContain("not started")
  })

  test("workflow mode keeps a visible fallback when progress text is empty", () => {
    const text = combineSidebarContentText({
      hostOverview: "Sessions\ntotal 1 | running 1",
      workflowText: "",
      hasWorkflow: true,
      hostMode: "workflow-list",
    })
    expect(text).toContain("SP: workflow active")
    expect(text).toContain("Sessions")
  })

  test("treats running session status as active and shows text snippet", () => {
    const api = {
      state: {
        path: { directory: "/tmp/project" },
        session: {
          status() {
            return { type: "running" }
          },
          messages() {
            return [{
              info: { id: "msg-1", role: "assistant" },
              parts: [{ type: "text", text: "Checking sidebar rendering." }],
            }]
          },
        },
      },
    }
    const text = renderSingleSessionFocus(api, {
      id: "session-1",
      title: "Main session",
      agent: "build",
      live_status: "running",
      active: true,
      updated_at: 1,
    })
    expect(text).toContain("Main session —")
    expect(text).toContain("Checking sidebar rendering.")
  })

  test("renders total and running counts with active sessions first", () => {
    const text = renderHostSessionsOverview([
      {
        id: "idle",
        title: "Idle session",
        agent: "superpowers-agent",
        live_status: "idle",
        active: false,
        updated_at: 10,
      },
      {
        id: "busy",
        title: "Running child",
        agent: "sp-implementer",
        parent_id: "parent-1",
        live_status: "busy",
        active: true,
        updated_at: 20,
      },
    ])
    expect(text).toContain("OpenCode sessions")
    expect(text).toContain("total 2 | running 1")
    expect(text.indexOf("sp-implementer")).toBeLessThan(text.indexOf("superpowers-agent"))
    expect(text).toContain("busy - Running child")
  })

  test("loads sessions from client list filtered by directory", async () => {
    const api = {
      state: {
        path: { directory: "/tmp/project" },
        session: {
          status(sessionID: string) {
            return sessionID === "child-1" ? { type: "busy" } : { type: "idle" }
          },
        },
      },
      client: {
        session: {
          async list() {
            return {
              data: [
                {
                  id: "parent-1",
                  title: "Controller",
                  agent: "superpowers-agent",
                  directory: "/tmp/project",
                  time: { updated: 100 },
                },
                {
                  id: "child-1",
                  title: "Implement task",
                  agent: "sp-implementer",
                  parentID: "parent-1",
                  directory: "/tmp/project",
                  time: { updated: 200 },
                },
                {
                  id: "other",
                  title: "Other project",
                  agent: "build",
                  directory: "/tmp/other",
                  time: { updated: 300 },
                },
              ],
            }
          },
        },
      },
    }
    const rows = await loadHostSessions(api, "/tmp/project")
    expect(rows.map((row) => row.id).sort()).toEqual(["child-1", "parent-1"])
    expect(rows[0]?.id).toBe("child-1")
    expect(isActiveHostSessionStatus(rows[0]?.live_status)).toBe(true)
  })

  test("falls back to state session get for known ids", () => {
    const api = {
      state: {
        path: { directory: "/tmp/project" },
        session: {
          get(sessionID: string) {
            if (sessionID === "child-1") {
              return {
                id: "child-1",
                title: "Child",
                agent: "sp-implementer",
                parentID: "parent-1",
                time: { updated: 50 },
              }
            }
            return undefined
          },
          status(sessionID: string) {
            return sessionID === "child-1" ? { type: "waiting_permission" } : { type: "idle" }
          },
        },
      },
    }
    const rows = readHostSessionsSync(api, ["child-1", "missing"])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.live_status).toBe("waiting_permission")
  })

  test("combines host overview with workflow-not-started message", () => {
    const text = combineSidebarContentText({
      hostOverview: "OpenCode sessions\ntotal 1 | running 1",
      workflowText: "",
      hasWorkflow: false,
    })
    expect(text).toContain("OpenCode sessions")
    expect(text).toContain("Superpowers workflow\nnot started")
  })
})
