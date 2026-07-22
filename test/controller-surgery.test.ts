import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkflowSpec } from "../src/capabilities/workflows"
import { buildAllowedControllerDecisions } from "../src/controller/feedback"
import { decideNextDispatches } from "../src/router/transition"
import {
  collectUnsatisfiedAncestorIDs,
  ensureWorkflowSpec,
} from "../src/router/workflow-spec-dispatch"
import { emptyDispatchReason, shouldEscalateEmptyDispatch } from "../src/runtime/empty-dispatch"
import { normalizeTaskGraph } from "../src/state/task-graph"
import { applyRecord, createInitialState } from "../src/state/transitions"
import { createProjectStore } from "../src/state/store"
import { createReportHandler } from "../src/tools/report-handler"
import type { WorkflowState } from "../src/state/types"

function baseState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  const initial = createInitialState({
    id: "run-1",
    project: "/tmp/project",
    session: "session-main",
    mode: "design",
    goal: "Ship M2-3",
  })
  return {
    ...initial,
    activation: "active",
    workflow: "feature",
    entrypoint: "feature",
    status: "running",
    phase: "code-review-passed",
    current_phase: "code-review-passed",
    gates: {
      plan_written: true,
      implementation_done: true,
      acceptance_passed: true,
      code_review_passed: true,
    },
    ...overrides,
  }
}

describe("never-stuck controller surgery", () => {
  test("normalizeTaskGraph coerces unknown agents to sp-implementer", () => {
    const graph = normalizeTaskGraph({
      tasks: [{
        id: "t1",
        title: "T1",
        summary: "do it",
        depends_on: [],
        agent: "sp-executor",
      }],
    })
    expect(graph.tasks[0]?.agent).toBe("sp-implementer")
  })

  test("applyRecord ignores false gates and keeps existing true", () => {
    const state = baseState({
      gates: { verification_fresh: true, code_review_passed: true },
      artifacts: { verification_log: "verification_log.md", code_review: "code_review.md" },
    })
    const next = applyRecord(state, {
      event: "verification",
      status: "passed",
      summary: "ok",
      artifacts: { verification_log: "# log" },
      gates: { verification_fresh: false },
    })
    expect(next.gates.verification_fresh).toBe(true)
  })

  test("dead-end graph escalates empty dispatch and notifies parent", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-empty-dispatch-"))
    try {
      const store = createProjectStore(project)
      const started = store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Dead end",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      store.setWorkflowSpec({
        runID: started.id,
        parentSessionID: "session-main",
        workflowSpec: createWorkflowSpec({
          id: `${started.id}-workflow-spec`,
          kind: "orchestration",
          title: "feature",
          orchestration: {
            nodes: [
              { id: "01-implement", agent: "sp-implementer", phase: "implement" },
              { id: "02-finish", agent: "sp-finisher", phase: "finish", depends_on: ["01-implement"] },
            ],
            edges: [{ from: "01-implement", to: "02-finish", condition: "passed" }],
          },
        }),
      })

      store.cancelNode({
        runID: started.id,
        nodeID: "01-implement",
        reason: "abort implement",
        parentSessionID: "session-main",
      })
      const continued = store.resolveControllerDecision({
        runID: started.id,
        parentSessionID: "session-main",
        decision: { kind: "continue_existing_graph", reason: "try again" },
      })
      const decisions = decideNextDispatches(continued)
      expect(decisions).toEqual([])
      expect(shouldEscalateEmptyDispatch(continued, decisions)).toBe(true)

      const escalated = store.markNeedsControllerDecision({
        runID: started.id,
        reason: "empty_dispatch",
        detail: emptyDispatchReason(continued),
      })
      expect(escalated.status).toBe("waiting_controller_decision")
      const allowed = buildAllowedControllerDecisions(escalated).map((item) => item.kind)
      expect(allowed).toContain("force_dispatch")
      expect(allowed).toContain("skip_node")
      expect(allowed).toContain("cancel_node")
      expect(allowed).toContain("replace_orchestration")

      let notified = false
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch() {
            throw new Error("should not dispatch")
          },
          async notifyParent() {
            notified = true
            return { action: "notified" as const }
          },
        },
      })

      store.resolveControllerDecision({
        runID: started.id,
        parentSessionID: "session-main",
        decision: { kind: "continue_existing_graph", reason: "running for report" },
      })
      store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-impl",
        task_markdown: "# task",
      })
      // After implement passes, edge wants finish but 01-implement latest is canceled (from earlier),
      // and the new running run will become passed — that would unlock finish.
      // Use replace_orchestration so finish depends on a never-satisfiable id.
      store.resolveControllerDecision({
        runID: started.id,
        parentSessionID: "session-main",
        decision: {
          kind: "replace_orchestration",
          reason: "orphan",
          orchestration: {
            nodes: [
              { id: "01-implement", agent: "sp-implementer", phase: "implement" },
              { id: "02-finish", agent: "sp-finisher", phase: "finish", depends_on: ["ghost"] },
            ],
            edges: [],
          },
        },
      })
      if (!store.readCurrent()!.node_runs.some((run) => run.status === "running")) {
        store.addNodeRun({
          phase: "implement",
          agent: "sp-implementer",
          session_id: "session-impl-b",
          task_markdown: "# task",
        })
      }
      const sessionID = store.readCurrent()!.node_runs.find((run) => run.status === "running")!.session_id
      const output = await handler({
        event: "implementation",
        status: "passed",
        summary: "done but nowhere to go",
        artifacts: { patch_summary: "# patch" },
        gates: { implementation_done: true },
      }, { sessionID, agent: "sp-implementer" })
      const result = JSON.parse(output)
      expect(result.state.status).toBe("waiting_controller_decision")
      expect(notified).toBe(true)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("force_dispatch skips ancestors then leaves finish runnable", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-force-dispatch-"))
    try {
      const store = createProjectStore(project)
      const started = store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Force finish",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      store.setWorkflowSpec({
        runID: started.id,
        parentSessionID: "session-main",
        workflowSpec: createWorkflowSpec({
          id: `${started.id}-workflow-spec`,
          kind: "orchestration",
          title: "feature",
          orchestration: {
            nodes: [
              { id: "01-implement", agent: "sp-implementer", phase: "implement" },
              { id: "02-acceptance", agent: "sp-acceptance-reviewer", phase: "acceptance", depends_on: ["01-implement"] },
              { id: "03-finish", agent: "sp-finisher", phase: "finish", depends_on: ["02-acceptance"] },
            ],
            edges: [
              { from: "01-implement", to: "02-acceptance", condition: "passed" },
              { from: "02-acceptance", to: "03-finish", condition: "passed" },
            ],
          },
        }),
      })
      store.markNeedsControllerDecision({
        runID: started.id,
        reason: "empty_dispatch",
        detail: "stuck",
      })

      const before = store.readCurrent()!
      expect(collectUnsatisfiedAncestorIDs(before, "03-finish")).toEqual(["01-implement", "02-acceptance"])

      const forced = store.resolveControllerDecision({
        runID: started.id,
        parentSessionID: "session-main",
        decision: {
          kind: "force_dispatch",
          node_id: "03-finish",
          reason: "Work already done outside graph; finish only.",
        },
      })
      expect(forced.node_runs.filter((run) => run.status === "skipped").map((run) => run.id).sort()).toEqual([
        "01-implement",
        "02-acceptance",
      ])
      expect(forced.status).toBe("running")
      const decisions = decideNextDispatches(forced)
      // Target itself is not yet passed; decideRunnable may also offer finish
      expect(decisions.some((decision) =>
        decision.action === "create_session" && decision.agent === "sp-finisher",
      )).toBe(true)
      expect(ensureWorkflowSpec(forced).orchestration.nodes.find((node) => node.id === "03-finish")).toBeTruthy()
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("skip_node satisfies depends_on; cancel_node does not", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-skip-cancel-"))
    try {
      const store = createProjectStore(project)
      const started = store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Skip vs cancel",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      store.setWorkflowSpec({
        runID: started.id,
        parentSessionID: "session-main",
        workflowSpec: createWorkflowSpec({
          id: `${started.id}-workflow-spec`,
          kind: "orchestration",
          title: "feature",
          orchestration: {
            nodes: [
              { id: "01-implement", agent: "sp-implementer", phase: "implement" },
              { id: "02-finish", agent: "sp-finisher", phase: "finish", depends_on: ["01-implement"] },
            ],
            edges: [{ from: "01-implement", to: "02-finish", condition: "passed" }],
          },
        }),
      })
      store.markNeedsControllerDecision({ runID: started.id, reason: "empty_dispatch", detail: "x" })

      const skipped = store.resolveControllerDecision({
        runID: started.id,
        parentSessionID: "session-main",
        decision: { kind: "skip_node", node_id: "01-implement", reason: "already done" },
      })
      expect(skipped.node_runs.some((run) => run.id === "01-implement" && run.status === "skipped")).toBe(true)
      const continued = store.resolveControllerDecision({
        runID: started.id,
        parentSessionID: "session-main",
        decision: { kind: "continue_existing_graph", reason: "resume after skip" },
      })
      expect(decideNextDispatches(continued).some((decision) =>
        decision.action === "create_session" && decision.agent === "sp-finisher",
      )).toBe(true)

      const canceled = store.resolveControllerDecision({
        runID: started.id,
        parentSessionID: "session-main",
        decision: { kind: "cancel_node", node_id: "02-finish", reason: "abort finish" },
      })
      expect(canceled.node_runs.some((run) => run.id === "02-finish" && run.status === "canceled")).toBe(true)
      expect(canceled.status).toBe("waiting_controller_decision")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
