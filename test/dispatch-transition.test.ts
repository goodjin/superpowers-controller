import { describe, expect, test } from "bun:test"
import { decideNextDispatches } from "../src/router/transition"
import type { SpRecordInput, WorkflowState } from "../src/state/types"

function state(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: "run-1",
    project: "/repo",
    session: "session-main",
    parent_session_id: "session-main",
    activation: "active",
    workflow: "feature",
    entrypoint: "feature",
    limited_context: false,
    mode: "design",
    phase: "implement",
    current_phase: "implement",
    status: "running",
    goal: "Add workflow gates",
    created_at: "2026-06-14T00:00:00.000Z",
    updated_at: "2026-06-14T00:00:00.000Z",
    gates: {},
    artifacts: {},
    node_runs: [],
    history: [],
    ...overrides,
  }
}

describe("decideNextDispatches", () => {
  test("intake passed dispatches the feature designer", () => {
    const decisions = decideNextDispatches(
      state({ current_phase: "intake", phase: "intake" }),
      {
        event: "intake",
        status: "passed",
        summary: "Confirmed.",
        artifacts: { request: "# Request" },
        gates: { request_confirmed: true },
      },
    )

    expect(decisions).toMatchObject([
      {
        action: "create_session",
        phase: "design",
        agent: "sp-designer",
      },
    ])
  })

  test("implementation passed dispatches acceptance review only", () => {
    const record: SpRecordInput = {
      event: "implementation",
      status: "passed",
      summary: "Implemented.",
      artifacts: { patch_summary: "Patch summary." },
      gates: { implementation_done: true },
    }

    const decisions = decideNextDispatches(state(), record)

    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ agent: "sp-acceptance-reviewer", phase: "acceptance" })
  })

  test("review transitions are serial", () => {
    const acceptance = decideNextDispatches(state({ current_phase: "acceptance" }), {
      event: "acceptance",
      status: "passed",
      summary: "Acceptance passed.",
      artifacts: { acceptance: "No issues." },
      gates: { acceptance_passed: true },
    })

    expect(acceptance).toHaveLength(1)
    expect(acceptance[0]).toMatchObject({ agent: "sp-verifier" })

    const verification = decideNextDispatches(state({ current_phase: "verification" }), {
      event: "verification",
      status: "passed",
      summary: "Verification passed.",
      artifacts: { verification_log: "Tests passed." },
      gates: { verification_fresh: true },
    })

    expect(verification).toHaveLength(1)
    expect(verification[0]).toMatchObject({ agent: "sp-code-reviewer" })
  })

  test("plan passed dispatches all runnable implementer tasks", () => {
    const decisions = decideNextDispatches(
      state({
        task_graph: {
          tasks: [
            { id: "T1", title: "Types", summary: "Add types", depends_on: [], files: ["src/types.ts"] },
            { id: "T2", title: "Store", summary: "Add store", depends_on: [], files: ["src/store.ts"] },
            { id: "T3", title: "UI", summary: "Add UI", depends_on: ["T1"] },
          ],
        },
      }),
      {
        event: "plan",
        status: "passed",
        summary: "Plan ready.",
        artifacts: { plan: "# Plan" },
        gates: { plan_written: true },
      },
    )

    expect(decisions.map((decision) => ("task_id" in decision ? decision.task_id : undefined))).toEqual(["T1", "T2"])
    expect(decisions.every((decision) => "agent" in decision && decision.agent === "sp-implementer")).toBe(true)
  })

  test("plan-only plan passed finishes without implementation dispatch", () => {
    const decisions = decideNextDispatches(
      state({
        workflow: "plan-only",
        mode: "plan",
        current_phase: "plan",
      }),
      {
        event: "plan",
        status: "passed",
        summary: "Plan ready.",
        artifacts: { plan: "# Plan" },
        gates: { plan_written: true },
      },
    )

    expect(decisions).toEqual([{ action: "finish", reason: "plan-only workflow complete" }])
  })

  test("investigation passed dispatches finisher", () => {
    const decisions = decideNextDispatches(
      state({
        workflow: "parallel-investigate",
        mode: "parallel-investigate",
        current_phase: "investigate",
      }),
      {
        event: "investigation",
        status: "passed",
        summary: "Investigation complete.",
        artifacts: { investigation: "Findings." },
      },
    )

    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ action: "create_session", agent: "sp-finisher", phase: "finish" })
  })

  test("code review failed reuses the last implementer session", () => {
    const decisions = decideNextDispatches(
      state({
        current_phase: "code-review",
        node_runs: [
          {
            id: "004-implement-T1",
            task_id: "T1",
            phase: "implement",
            agent: "sp-implementer",
            primary_skill: "superpowers-test-driven-development",
            session_id: "ses_impl",
            status: "passed",
            attempts: 1,
            started_at: "2026-06-14T00:00:00.000Z",
          },
        ],
      }),
      {
        event: "code-review",
        status: "failed",
        summary: "Code review failed.",
        findings: "Missing edge case.",
      },
    )

    expect(decisions[0]?.action).toBe("reuse_session")
    expect(decisions[0]).toMatchObject({ session_id: "ses_impl", agent: "sp-implementer" })
  })

  test("needs_user records wait decision without dispatch", () => {
    const decisions = decideNextDispatches(state(), {
      event: "question",
      status: "needs_user",
      summary: "Need a choice.",
      question: { prompt: "Strict gates?" },
    })

    expect(decisions).toEqual([{ action: "wait_user", reason: "node requested user input" }])
  })
})
