import { describe, expect, test } from "bun:test"
import { buildSidebarViewModel } from "../src/tui/sidebar-model"
import { isSidebarDebugEnabled, summarizeSidebarModel } from "../src/tui/sidebar-debug"

describe("sidebar debug", () => {
  test("summarizeSidebarModel includes activity for single-focus", () => {
    const model = buildSidebarViewModel({
      hasWorkflow: false,
      hostMode: "single-focus",
      host: {
        kind: "single-focus",
        title: "Investigate routing",
        activity: "thinking…",
      },
    })
    const summary = summarizeSidebarModel(model)
    expect(summary.activity).toBe("thinking…")
    expect(summary.hostKind).toBe("single-focus")
    expect(String(summary.textPreview)).toContain("thinking")
  })

  test("debug flag reads env", () => {
    const previous = process.env.SUPERPOWERS_SIDEBAR_DEBUG
    process.env.SUPERPOWERS_SIDEBAR_DEBUG = "1"
    expect(isSidebarDebugEnabled()).toBe(true)
    if (previous === undefined) delete process.env.SUPERPOWERS_SIDEBAR_DEBUG
    else process.env.SUPERPOWERS_SIDEBAR_DEBUG = previous
  })
})
