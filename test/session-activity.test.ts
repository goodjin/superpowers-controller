import { describe, expect, test } from "bun:test"
import { buildControllerFeedback } from "../src/controller/feedback"
import { findPermissionWaitingFromProgress, findStalledRunningNode } from "../src/runtime/session-activity"
import type { WorkflowState } from "../src/state/types"

function runningState(): WorkflowState {
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
    node_runs: [{
      id: "001-implement-T1",
      task_id: "T1",
      phase: "implement",
      agent: "sp-implementer",
      session_id: "session-child",
      status: "running",
      attempts: 1,
      started_at: "2026-01-01T00:00:00.000Z",
    }],
    history: [],
  }
}

describe("session activity feedback", () => {
  test("findPermissionWaitingFromProgress detects waiting_permission progress", () => {
    const state = runningState()
    const result = findPermissionWaitingFromProgress(state, {
      "001-implement-T1": [{
        at: "2026-01-01T00:00:10.000Z",
        kind: "session_status",
        session_id: "session-child",
        node_id: "001-implement-T1",
        agent: "sp-implementer",
        phase: "implement",
        summary: "session waiting_permission",
      }],
    })

    expect(result?.session_id).toBe("session-child")
    expect(result?.hint).toContain("session-child")
  })

  test("buildControllerFeedback exposes permission_context from progress", () => {
    const state = runningState()
    const feedback = buildControllerFeedback(state, undefined, {
      progressByNode: {
        "001-implement-T1": [{
          at: "2026-01-01T00:00:10.000Z",
          kind: "session_status",
          session_id: "session-child",
          node_id: "001-implement-T1",
          agent: "sp-implementer",
          phase: "implement",
          summary: "session waiting_permission",
        }],
      },
    })

    expect(feedback.permission_context?.session_id).toBe("session-child")
    expect(feedback.blocking_reason).toContain("session-child")
  })

  test("findStalledRunningNode detects stale progress", () => {
    const state = runningState()
    const stalled = findStalledRunningNode(state, {
      "001-implement-T1": [{
        at: "2026-01-01T00:00:00.000Z",
        kind: "text",
        session_id: "session-child",
        node_id: "001-implement-T1",
        agent: "sp-implementer",
        phase: "implement",
        summary: "assistant text updated",
      }],
    }, new Date("2026-01-01T00:01:00.000Z"), 30_000)

    expect(stalled?.idle_ms).toBe(60_000)
  })
})
