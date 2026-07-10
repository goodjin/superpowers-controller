import { describe, expect, test } from "bun:test"
import {
  buildParallelContext,
  resolveWorkflowStatusAfterNodeReport,
  sessionErrorNodeStatus,
  workflowStatusAfterNodeFailure,
} from "../src/runtime/workflow-attention"
import type { WorkflowState } from "../src/state/types"

function baseState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: "run-1",
    project: "/tmp/project",
    session: "parent",
    parent_session_id: "parent",
    activation: "active",
    workflow: "feature",
    entrypoint: "feature",
    limited_context: false,
    mode: "execute",
    phase: "implement",
    current_phase: "implement",
    status: "running",
    goal: "goal",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    gates: {},
    artifacts: {},
    node_runs: [],
    history: [],
    task_graph: {
      tasks: [
        { id: "T1", title: "T1", summary: "T1", depends_on: [] },
        { id: "T2", title: "T2", summary: "T2", depends_on: [] },
      ],
    },
    ...overrides,
  }
}

describe("workflow attention helpers", () => {
  test("keeps workflow running when one parallel node fails and another is still running", () => {
    const state = baseState({
      node_runs: [
        {
          id: "001-implement-T1",
          task_id: "T1",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "s1",
          status: "failed",
          attempts: 1,
          started_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "002-implement-T2",
          task_id: "T2",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "s2",
          status: "running",
          attempts: 1,
          started_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    })

    expect(resolveWorkflowStatusAfterNodeReport(state, "001-implement-T1", "failed")).toBe("running")
    expect(workflowStatusAfterNodeFailure(state, state.node_runs)).toBe("running")
  })

  test("enters waiting_controller_decision when the last running node fails", () => {
    const state = baseState({
      node_runs: [
        {
          id: "001-implement-T1",
          task_id: "T1",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "s1",
          status: "failed",
          attempts: 1,
          started_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    })

    expect(resolveWorkflowStatusAfterNodeReport(state, "001-implement-T1", "failed")).toBe("waiting_controller_decision")
    expect(workflowStatusAfterNodeFailure(state, state.node_runs)).toBe("waiting_controller_decision")
  })

  test("buildParallelContext reports failed and running siblings", () => {
    const state = baseState({
      node_runs: [
        {
          id: "001-implement-T1",
          task_id: "T1",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "s1",
          status: "dispatch_failed",
          attempts: 1,
          started_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "002-implement-T2",
          task_id: "T2",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "s2",
          status: "running",
          attempts: 1,
          started_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    })

    expect(buildParallelContext(state)).toEqual({
      failed_nodes: [{
        node_id: "001-implement-T1",
        task_id: "T1",
        session_id: "s1",
        status: "dispatch_failed",
      }],
      running_nodes: [{
        node_id: "002-implement-T2",
        task_id: "T2",
        session_id: "s2",
      }],
      blocked_downstream: [],
    })
  })

  test("sessionErrorNodeStatus maps auth/model errors to failed", () => {
    expect(sessionErrorNodeStatus("HTTP 401 unauthorized")).toBe("failed")
    expect(sessionErrorNodeStatus("model not found")).toBe("failed")
    expect(sessionErrorNodeStatus("request timed out")).toBe("interrupted")
  })
})
