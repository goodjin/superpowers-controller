import { describe, expect, test } from "bun:test"
import {
  buildSidebarHostModel,
  buildSidebarViewModel,
  renderSidebarHostModelText,
  renderSidebarViewModelText,
} from "../src/tui/sidebar-model"
import type { HostSessionRow } from "../src/tui/host-sessions"

describe("sidebar model", () => {
  test("single-focus model matches legacy text layout", () => {
    const rows: HostSessionRow[] = [{
      id: "session-main",
      title: "Investigate vpn routing",
      agent: "build",
      live_status: "busy",
      active: true,
      updated_at: 1,
    }]
    const api = {
      state: {
        session: {
          messages(sessionID: string) {
            expect(sessionID).toBe("session-main")
            return [{
              info: { id: "msg-1", role: "assistant" },
              parts: [{ type: "tool", tool: "grep", state: { status: "running", title: "sidebar" } }],
            }]
          },
        },
      },
    } as never
    const host = buildSidebarHostModel(api, rows, "single-focus")
    expect(host).toEqual({
      kind: "single-focus",
      title: "Investigate vpn routing",
      activity: "calling Grep sidebar",
    })
    expect(renderSidebarHostModelText(host)).toBe("Session\n↳ Grep sidebar\nInvestigate vpn routing")
  })

  test("workflow-list model renders session rows", () => {
    const rows: HostSessionRow[] = [
      {
        id: "session-child",
        title: "editing renderer",
        agent: "sp-implementer",
        parent_id: "session-main",
        live_status: "running",
        active: true,
        updated_at: 2,
      },
      {
        id: "session-main",
        title: "Main controller session",
        agent: "superpowers-agent",
        live_status: "idle",
        active: false,
        updated_at: 1,
      },
    ]
    const host = buildSidebarHostModel({ state: { session: { status: () => ({ type: "idle" }) } } } as never, rows, "workflow-list")
    expect(host.kind).toBe("session-list")
    if (host.kind !== "session-list") return
    expect(host.summary).toBe("total 2 | running 1")
    expect(host.rows[0]?.marker).toBe("●")
    expect(renderSidebarHostModelText(host)).toContain("● sp-implementer child: thinking…")
  })

  test("view model combines workflow and host sections", () => {
    const model = buildSidebarViewModel({
      hasWorkflow: true,
      hostMode: "workflow-list",
      workflowText: "SP feature running\nchild sessions",
      host: {
        kind: "session-list",
        heading: "Sessions",
        summary: "total 1 | running 1",
        rows: [{
          marker: "●",
          shortcut: "",
          agent: "sp-implementer",
          parentSuffix: " child",
          status: "running",
          title: "editing renderer",
          active: true,
        }],
      },
    })
    const text = renderSidebarViewModelText(model)
    expect(text).toContain("SP feature running")
    expect(text).toContain("child sessions")
    expect(text).toContain("Sessions")
    expect(text).toContain("● sp-implementer child: running · editing renderer")
  })
})
