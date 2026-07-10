import { describe, expect, test } from "bun:test"
import { findBuiltInWorkflowTemplate } from "../src/capabilities/workflows"
import { decideNextDispatches } from "../src/router/transition"
import { ensureWorkflowSpec } from "../src/router/workflow-spec-dispatch"
import type { WorkflowState } from "../src/state/types"

function state(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: "run-spec",
    project: "/repo",
    session: "session-main",
    parent_session_id: "session-main",
    activation: "active",
    workflow: "feature",
    entrypoint: "feature",
    limited_context: false,
    mode: "design",
    phase: "plan",
    current_phase: "plan-complete",
    status: "running",
    goal: "Spec-driven dispatch",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    gates: {},
    artifacts: {},
    node_runs: [],
    history: [],
    ...overrides,
  }
}

describe("workflow-spec-driven dispatch", () => {
  test("built-in feature template includes designer and explicit edges", () => {
    const template = findBuiltInWorkflowTemplate("feature")
    expect(template?.orchestration.nodes[0]?.agent).toBe("sp-designer")
    expect(template?.orchestration.edges?.some((edge) => edge.from === "01-design" && edge.to === "02-plan")).toBe(true)
  })

  test("ensureWorkflowSpec merges task graph nodes into an existing workflow spec", () => {
    const template = findBuiltInWorkflowTemplate("feature")
    const spec = ensureWorkflowSpec(state({
      workflow_spec: {
        id: "run-spec-workflow-spec",
        kind: "built_in_workflow",
        title: "Feature",
        auto_expansion: { allow: true },
        orchestration: template!.orchestration,
        created_at: "2026-07-10T00:00:00.000Z",
        updated_at: "2026-07-10T00:00:00.000Z",
      },
      task_graph: {
        tasks: [{ id: "T1", title: "Task", summary: "Do work", depends_on: [] }],
      },
    }))

    expect(spec.orchestration.nodes.some((node) => node.id === "task-T1")).toBe(true)
    expect(spec.orchestration.nodes.some((node) => node.id === "task-T1-acceptance")).toBe(true)
    expect(spec.orchestration.edges?.some((edge) => edge.from === "task-T1" && edge.to === "task-T1-acceptance")).toBe(true)
  })

  test("plan passed dispatches from workflow-spec task nodes instead of template implement node", () => {
    const decisions = decideNextDispatches(
      state({
        task_graph: {
          tasks: [
            { id: "T1", title: "Types", summary: "Add types", depends_on: [] },
            { id: "T2", title: "Store", summary: "Add store", depends_on: ["T1"] },
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

    expect(decisions.map((decision) => ("task_id" in decision ? decision.task_id : undefined))).toEqual(["T1"])
  })
})
