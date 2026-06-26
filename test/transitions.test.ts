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
      event: "debug",
      status: "passed",
      summary: "Root cause found.",
      artifacts: { root_cause: "The parser treats protocol JSON as text." },
      gates: { root_cause_found: true },
    })

    expect(next.gates.root_cause_found).toBe(true)
    expect(next.artifacts.root_cause).toBe("root_cause.md")
    expect(next.history.at(-1)?.event).toBe("debug")
    expect(next.history.at(-1)?.status).toBe("passed")
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
        event: "debug",
        status: "passed",
        summary: "Root cause found.",
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
        event: "implementation",
        status: "passed",
        summary: "Bulk update.",
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
        event: "finish",
        status: "passed",
        summary: "Ready to finish.",
        artifacts: { finish_note: "Implemented plugin MVP." },
      }),
    ).toThrow("verification_fresh")
  })

  test("marks plan-only workflow passed when plan is recorded", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "plan",
      goal: "plan implementation",
    })

    const next = applyRecord(state, {
      event: "plan",
      status: "passed",
      summary: "Plan ready.",
      artifacts: { plan: "# Plan" },
      gates: { plan_written: true },
    })

    expect(next.status).toBe("passed")
    expect(next.phase).toBe("plan-complete")
  })

  test("allows parallel investigation completion without fresh verification", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "parallel-investigate",
      goal: "investigate options",
    })

    const next = applyRecord(state, {
      event: "finish",
      status: "passed",
      summary: "Investigation summarized.",
      artifacts: { finish_note: "Investigation result." },
    })

    expect(next.status).toBe("passed")
    expect(next.phase).toBe("finished")
  })

  test("rejects completion while task graph tasks are not all passed", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "verify-finish",
      goal: "finish work",
      gates: { verification_fresh: true },
    })
    const withTaskGraph = {
      ...state,
      task_graph: {
        tasks: [
          { id: "T1", title: "API", summary: "Build API", depends_on: [] },
          { id: "T2", title: "Dashboard", summary: "Build dashboard", depends_on: ["T1"] },
        ],
      },
      node_runs: [
        {
          id: "001-implement-T1",
          task_id: "T1",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "session-t1",
          status: "passed" as const,
          attempts: 1,
          started_at: "2026-06-20T00:00:00.000Z",
          ended_at: "2026-06-20T00:01:00.000Z",
        },
      ],
    }

    expect(() =>
      applyRecord(withTaskGraph, {
        event: "finish",
        status: "passed",
        summary: "Ready to finish.",
        artifacts: { finish_note: "Implemented available tasks." },
      }),
    ).toThrow("incomplete tasks")
  })

  test("allows completion only after task implementation and required checks pass", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "execute",
      goal: "finish work",
      gates: { verification_fresh: true },
    })
    const withCompletedTask = {
      ...state,
      workflow: "feature" as const,
      task_graph: {
        tasks: [
          { id: "T1", title: "API", summary: "Build API", depends_on: [] },
        ],
      },
      node_runs: [
        {
          id: "001-implement-T1",
          task_id: "T1",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "session-implement",
          status: "passed" as const,
          attempts: 1,
          started_at: "2026-06-20T00:00:00.000Z",
        },
        {
          id: "002-acceptance-T1",
          task_id: "T1",
          phase: "acceptance",
          agent: "sp-acceptance-reviewer",
          session_id: "session-acceptance",
          status: "passed" as const,
          attempts: 1,
          started_at: "2026-06-20T00:01:00.000Z",
        },
        {
          id: "003-verification-T1",
          task_id: "T1",
          phase: "verification",
          agent: "sp-verifier",
          session_id: "session-verification",
          status: "passed" as const,
          attempts: 1,
          started_at: "2026-06-20T00:02:00.000Z",
        },
        {
          id: "004-code-review-T1",
          task_id: "T1",
          phase: "code-review",
          agent: "sp-code-reviewer",
          session_id: "session-code-review",
          status: "passed" as const,
          attempts: 1,
          started_at: "2026-06-20T00:03:00.000Z",
        },
      ],
    }

    const next = applyRecord(withCompletedTask, {
      event: "finish",
      status: "passed",
      summary: "Ready to finish.",
      artifacts: { finish_note: "Implemented and checked." },
    })

    expect(next.status).toBe("passed")
    expect(next.phase).toBe("finished")
  })
})
