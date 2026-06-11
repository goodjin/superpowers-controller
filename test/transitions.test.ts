import { describe, expect, test } from "bun:test"
import { applyRecord, createInitialState } from "../src/state/transitions"

describe("applyRecord", () => {
  test("accepts root cause gate when matching artifact is recorded", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "debug",
      goal: "fix failing tests",
    })

    const next = applyRecord(state, {
      event: "root-cause-found",
      artifacts: { root_cause: "The parser treats protocol JSON as text." },
      gates: { root_cause_found: true },
    })

    expect(next.gates.root_cause_found).toBe(true)
    expect(next.artifacts.root_cause).toBe("root_cause.md")
    expect(next.history.at(-1)?.event).toBe("root-cause-found")
  })

  test("rejects evidence-backed gate without matching artifact", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "debug",
      goal: "fix failing tests",
    })

    expect(() =>
      applyRecord(state, {
        event: "root-cause-found",
        gates: { root_cause_found: true },
      }),
    ).toThrow("root_cause")
  })

  test("rejects setting too many gates in a single record", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "execute",
      goal: "implement the plan",
    })

    expect(() =>
      applyRecord(state, {
        event: "bulk-update",
        gates: {
          design_approved: true,
          spec_written: true,
          plan_written: true,
          root_cause_found: true,
        },
        artifacts: {
          spec: "spec",
          plan: "plan",
          root_cause: "root cause",
        },
      }),
    ).toThrow("too many gates")
  })

  test("rejects completion record without fresh verification", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "verify-finish",
      goal: "finish work",
    })

    expect(() =>
      applyRecord(state, {
        event: "done",
        artifacts: { patch_summary: "Implemented plugin MVP." },
      }),
    ).toThrow("verification_fresh")
  })
})
