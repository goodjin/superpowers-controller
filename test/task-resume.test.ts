import { describe, expect, test } from "bun:test"
import { buildAllowedControllerDecisions, buildControllerFeedback, buildRecommendedNext } from "../src/controller/feedback"
import { decideTaskResumeDispatch, decideTaskResumeDispatches, parseResumeTaskIDs } from "../src/runtime/task-resume"
import type { WorkflowState } from "../src/state/types"

function featureState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: "run-1",
    project: "/tmp/project",
    session: "session-main",
    parent_session_id: "session-main",
    activation: "active",
    workflow: "feature",
    entrypoint: "feature",
    goal: "Test",
    mode: "execute",
    phase: "implementation",
    current_phase: "implementation",
    status: "recovered_unknown",
    gates: {},
    artifacts: {},
    node_runs: [],
    task_graph: {
      tasks: [
        { id: "T1", title: "Task 1", summary: "First", depends_on: [] },
        { id: "T2", title: "Task 2", summary: "Second", depends_on: ["T1"] },
      ],
    },
    history: [],
    updated_at: new Date().toISOString(),
    state_version: "v1",
    ...overrides,
  }
}

describe("task resume", () => {
  test("parseResumeTaskIDs supports all and explicit task ids", () => {
    const state = featureState()
    expect(parseResumeTaskIDs(state, "all")).toEqual(["T1", "T2"])
    expect(parseResumeTaskIDs(state, "T2")).toEqual(["T2"])
    expect(parseResumeTaskIDs(state, ["T1"])).toEqual(["T1"])
    expect(parseResumeTaskIDs(state, undefined, "T1")).toEqual(["T1"])
  })

  test("resumes interrupted implement phase for a task", () => {
    const state = featureState({
      node_runs: [{
        id: "001-implement-T1",
        task_id: "T1",
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-old",
        status: "interrupted",
        attempts: 1,
        started_at: new Date().toISOString(),
      }],
    })

    expect(decideTaskResumeDispatch(state, "T1")).toMatchObject({
      action: "create_session",
      phase: "implement",
      agent: "sp-implementer",
      task_id: "T1",
    })
  })

  test("resumes verification when implement already passed", () => {
    const state = featureState({
      node_runs: [
        {
          id: "001-implement-T1",
          task_id: "T1",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "session-impl",
          status: "passed",
          attempts: 1,
          started_at: new Date().toISOString(),
          reported_at: new Date().toISOString(),
          closed_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
        },
        {
          id: "002-acceptance-T1",
          task_id: "T1",
          phase: "acceptance",
          agent: "sp-acceptance-reviewer",
          session_id: "session-acc",
          status: "passed",
          attempts: 1,
          started_at: new Date().toISOString(),
          reported_at: new Date().toISOString(),
          closed_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
        },
        {
          id: "003-verification-T1",
          task_id: "T1",
          phase: "verification",
          agent: "sp-verifier",
          session_id: "session-verify",
          status: "interrupted",
          attempts: 1,
          started_at: new Date().toISOString(),
        },
      ],
    })

    expect(decideTaskResumeDispatch(state, "T1")).toMatchObject({
      phase: "verification",
      agent: "sp-verifier",
      task_id: "T1",
    })
  })

  test("resume all skips completed tasks and respects dependencies", () => {
    const state = featureState({
      node_runs: [
        {
          id: "001-implement-T1",
          task_id: "T1",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "session-t1",
          status: "passed",
          attempts: 1,
          started_at: new Date().toISOString(),
          reported_at: new Date().toISOString(),
          closed_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
        },
        {
          id: "002-implement-T2",
          task_id: "T2",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "session-t2",
          status: "interrupted",
          attempts: 1,
          started_at: new Date().toISOString(),
        },
      ],
    })

    expect(decideTaskResumeDispatches(state, ["T1", "T2"]).map((decision) => decision.task_id)).toEqual(["T1"])
  })

  test("recovered_unknown feedback steers resume instead of retry_node", () => {
    const state = featureState({
      node_runs: [{
        id: "001-implement-T1",
        task_id: "T1",
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-old",
        status: "interrupted",
        attempts: 1,
        started_at: new Date().toISOString(),
      }],
    })

    const recommended = buildRecommendedNext(state)
    expect(recommended).toEqual([{
      action: "blocked",
      reason: 'Call sp_start(run_id, resume="all") or resume=[task_id] to continue interrupted tasks.',
    }])
    expect(recommended.some((next) => next.action === "retry_node")).toBe(false)

    const decisions = buildAllowedControllerDecisions(state)
    expect(decisions.map((decision) => decision.kind)).toEqual(["mark_blocked", "request_reprepare"])
    expect(decisions.some((decision) => decision.kind === "retry_node")).toBe(false)

    const feedback = buildControllerFeedback(state)
    expect(feedback.blocking_reason).toContain('sp_start(run_id, resume="all")')
    expect(feedback.inspection_hints?.[0]?.reason).toContain('sp_start(run_id, resume="all")')
  })
})
