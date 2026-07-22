import { describe, expect, test } from "bun:test"
import { createOpenCodeSessionAdapter } from "../src/session/adapter"

describe("createOpenCodeSessionAdapter", () => {
  test("creates designer sessions without parentID for interactive foreground", async () => {
    const createdInputs: unknown[] = []
    const adapter = createOpenCodeSessionAdapter({
      client: {
        session: {
          async create(input: unknown) {
            createdInputs.push(input)
            return { id: "session-design" }
          },
        },
      },
    } as never)

    const sessionID = await adapter.createNodeSession({
      parentSessionID: "session-main",
      title: "Design node",
      agent: "sp-designer",
    })

    expect(sessionID).toBe("session-design")
    expect(createdInputs).toEqual([
      {
        body: {
          title: "Design node",
          agent: "sp-designer",
        },
      },
    ])
  })

  test("creates non-design node sessions with parentID", async () => {
    const createdInputs: unknown[] = []
    const adapter = createOpenCodeSessionAdapter({
      client: {
        session: {
          async create(input: unknown) {
            createdInputs.push(input)
            return { id: "session-implement" }
          },
        },
      },
    } as never)

    const sessionID = await adapter.createNodeSession({
      parentSessionID: "session-main",
      title: "Implement T1",
      agent: "sp-implementer",
    })

    expect(sessionID).toBe("session-implement")
    expect(createdInputs).toEqual([
      {
        body: {
          parentID: "session-main",
          title: "Implement T1",
          agent: "sp-implementer",
        },
      },
    ])
  })

  test("creates controller sessions without parentID", async () => {
    const createdInputs: unknown[] = []
    const adapter = createOpenCodeSessionAdapter({
      client: {
        session: {
          async create(input: unknown) {
            createdInputs.push(input)
            return { id: "session-clean-controller" }
          },
        },
      },
    } as never)

    const sessionID = await adapter.createControllerSession({
      title: "Superpowers: clean handoff",
      agent: "superpowers-agent",
    })

    expect(sessionID).toBe("session-clean-controller")
    expect(createdInputs).toEqual([
      {
        body: {
          title: "Superpowers: clean handoff",
          agent: "superpowers-agent",
        },
      },
    ])
  })

  test("selects a TUI session with the direct API when available", async () => {
    const selected: unknown[] = []
    const adapter = createOpenCodeSessionAdapter({
      client: {
        tui: {
          async selectSession(input: unknown) {
            selected.push(input)
          },
        },
      },
    } as never)

    await adapter.selectSession?.({ sessionID: "session-design", reason: "foreground design" })

    expect(selected).toEqual([{ sessionID: "session-design" }])
  })

  test("falls back to publishing a tui.session.select event", async () => {
    const published: unknown[] = []
    const adapter = createOpenCodeSessionAdapter({
      client: {
        tui: {
          async publish(input: unknown) {
            published.push(input)
          },
        },
      },
    } as never)

    await adapter.selectSession?.({ sessionID: "session-plan" })

    expect(published).toEqual([
      {
        body: {
          type: "tui.session.select",
          properties: { sessionID: "session-plan" },
        },
      },
    ])
  })

  test("warns instead of failing when TUI session selection is unavailable", async () => {
    const toasts: unknown[] = []
    const adapter = createOpenCodeSessionAdapter({
      client: {
        tui: {
          async showToast(input: unknown) {
            toasts.push(input)
          },
        },
      },
    } as never)

    await adapter.selectSession?.({ sessionID: "session-child" })

    expect(toasts[0]).toMatchObject({
      body: {
        stage: "tui_session_select_failed",
        variant: "warning",
      },
    })
  })
})
