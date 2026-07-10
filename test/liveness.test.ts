import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_LIVENESS_TIMEOUT_MS, findExpiredRunningNodes } from "../src/runtime/liveness"
import { createNodeProgressStore } from "../src/progress/node-progress"
import { createProjectStore } from "../src/state/store"
import type { WorkflowState } from "../src/state/types"

function baseState(): WorkflowState {
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
      session_id: "session-T1",
      status: "running",
      attempts: 1,
      started_at: "2026-01-01T00:00:00.000Z",
    }],
    history: [],
  }
}

describe("liveness monitor", () => {
  test("findExpiredRunningNodes flags stale progress beyond timeout", () => {
    const state = baseState()
    const now = new Date("2026-01-01T00:02:00.000Z")
    const expired = findExpiredRunningNodes({
      state,
      progressByNode: {
        "001-implement-T1": [{
          at: "2026-01-01T00:00:00.000Z",
          kind: "text",
          session_id: "session-T1",
          node_id: "001-implement-T1",
          agent: "sp-implementer",
          phase: "implement",
          task_id: "T1",
          summary: "assistant text updated",
        }],
      },
      now,
      timeoutMs: DEFAULT_LIVENESS_TIMEOUT_MS,
    })

    expect(expired).toHaveLength(1)
    expect(expired[0]?.idle_ms).toBe(120_000)
  })

  test("findExpiredRunningNodes ignores fresh progress", () => {
    const state = baseState()
    const now = new Date("2026-01-01T00:00:45.000Z")
    const expired = findExpiredRunningNodes({
      state,
      progressByNode: {
        "001-implement-T1": [{
          at: "2026-01-01T00:00:30.000Z",
          kind: "text",
          session_id: "session-T1",
          node_id: "001-implement-T1",
          agent: "sp-implementer",
          phase: "implement",
          summary: "assistant text updated",
        }],
      },
      now,
      timeoutMs: DEFAULT_LIVENESS_TIMEOUT_MS,
    })

    expect(expired).toHaveLength(0)
  })

  test("markLivenessExpired closes a stale running node", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-liveness-"))
    try {
      const store = createProjectStore(project)
      const progress = createNodeProgressStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Task",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-T1",
        task_id: "T1",
        task_markdown: "# Task",
      })

      const state = store.readCurrent()!
      progress.append(state.id, {
        at: "2026-01-01T00:00:00.000Z",
        kind: "text",
        session_id: "session-T1",
        node_id: state.node_runs[0]!.id,
        agent: "sp-implementer",
        phase: "implement",
        task_id: "T1",
        summary: "assistant text updated",
      })

      const expired = findExpiredRunningNodes({
        state,
        progressByNode: progress.readRun(state),
        now: new Date("2026-01-01T00:02:00.000Z"),
        timeoutMs: DEFAULT_LIVENESS_TIMEOUT_MS,
      })
      expect(expired).toHaveLength(1)

      const updated = store.markLivenessExpired({
        session_id: "session-T1",
        idle_ms: expired[0]!.idle_ms,
      })
      expect(updated?.status).toBe("interrupted")
      expect(store.readCurrent()?.status).toBe("waiting_controller_decision")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
