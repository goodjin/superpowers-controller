import { describe, expect, test } from "bun:test"
import { extractChildLiveActivity, extractSessionCurrentAction, liveActivityBySession } from "../src/tui/live-activity"

describe("child live activity", () => {
  test("extractSessionCurrentAction prefers running tool over thinking", () => {
    const reader = {
      messages() {
        return [{
          info: { id: "msg-1", role: "assistant" },
          parts: [
            { type: "reasoning", text: "still planning" },
            { type: "tool", tool: "bash", state: { status: "running", title: "bun test" } },
          ],
        }]
      },
    }
    expect(extractSessionCurrentAction(reader, "session-1", "busy")).toEqual({
      kind: "tool",
      label: "calling Bash bun test",
    })
  })

  test("extractSessionCurrentAction reports thinking for busy session without tools", () => {
    const reader = {
      messages() {
        return [{
          info: { id: "msg-1", role: "assistant" },
          parts: [{ type: "reasoning", text: "working through options" }],
        }]
      },
    }
    expect(extractSessionCurrentAction(reader, "session-1", "busy")).toEqual({
      kind: "thinking",
      label: "thinking",
    })
  })

  test("extractSessionCurrentAction reports waiting permission", () => {
    expect(extractSessionCurrentAction({ messages: () => [] }, "session-1", "waiting_permission")).toEqual({
      kind: "waiting_permission",
      label: "waiting permission",
    })
  })

  test("formats running tool with title like native task card", () => {
    const reader = {
      messages(sessionID: string) {
        expect(sessionID).toBe("session-child")
        return [
          {
            info: { id: "msg-1", role: "assistant" },
            parts: [
              {
                type: "tool",
                tool: "edit",
                state: {
                  status: "running",
                  title: "src/tui/progress-panel.ts",
                  input: { filePath: "src/tui/progress-panel.ts" },
                },
              },
            ],
          },
        ]
      },
    }

    const activity = extractChildLiveActivity(reader, "session-child")
    expect(activity).toEqual({
      summary: "calling Edit src/tui/progress-panel.ts",
      detail: "src/tui/progress-panel.ts",
      tool_count: 1,
      current_tool: "Edit src/tui/progress-panel.ts",
      observed_at: undefined,
    })
  })

  test("falls back to toolcall count when running tool has no title", () => {
    const reader = {
      messages() {
        return [
          {
            parts: [
              { type: "tool", tool: "bash", state: { status: "completed", title: "done" } },
              { type: "tool", tool: "grep", state: { status: "running", input: { pattern: "foo" } } },
            ],
          },
        ]
      },
    }

    expect(extractChildLiveActivity(reader, "session-child")?.summary).toBe("calling 1 toolcall")
  })

  test("extractSessionCurrentAction shows last completed tool when idle", () => {
    const reader = {
      messages() {
        return [{
          parts: [
            { type: "tool", tool: "sp_status", state: { status: "completed" } },
          ],
        }]
      },
    }
    expect(extractSessionCurrentAction(reader, "session-1", "idle")).toEqual({
      kind: "tool",
      label: "last Sp_status",
    })
  })

  test("formats completed activity with last tool label", () => {
    const reader = {
      messages() {
        return [
          {
            parts: [
              { type: "tool", tool: "bash", state: { status: "completed", title: "bun test" } },
            ],
          },
        ]
      },
    }

    expect(extractChildLiveActivity(reader, "session-child")?.summary).toBe("last Bash bun test")
  })

  test("reads parts through api.state.part when message has no inline parts", () => {
    const reader = {
      messages() {
        return [{ info: { id: "msg-2", role: "assistant" } }]
      },
      part(messageID: string) {
        expect(messageID).toBe("msg-2")
        return [
          {
            type: "tool",
            tool: "write",
            state: { status: "running", title: "docs/features/foo.md" },
          },
        ]
      },
    }

    expect(extractChildLiveActivity(reader, "session-child")?.summary).toBe("calling Write docs/features/foo.md")
  })

  test("liveActivityBySession only includes sessions with tool activity", () => {
    const reader = {
      messages(sessionID: string) {
        if (sessionID === "session-a") {
          return [{ parts: [{ type: "tool", tool: "bash", state: { status: "running", title: "bun test" } }] }]
        }
        return [{ parts: [{ type: "text", text: "hello" }] }]
      },
    }

    expect(liveActivityBySession(reader, ["session-a", "session-b"])).toEqual({
      "session-a": {
        summary: "calling Bash bun test",
        detail: "bun test",
        tool_count: 1,
        current_tool: "Bash bun test",
        observed_at: undefined,
      },
    })
  })
})
