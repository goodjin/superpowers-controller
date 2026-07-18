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
        tasks: [
          { id: "T1", title: "Task", summary: "Do work", depends_on: [] },
          { id: "T2", title: "Next", summary: "Depends on T1", depends_on: ["T1"] },
        ],
      },
    }))

    expect(spec.orchestration.nodes.some((node) => node.id === "task-T1")).toBe(true)
    expect(spec.orchestration.nodes.some((node) => node.id === "task-T1-acceptance")).toBe(true)
    expect(spec.orchestration.edges?.some((edge) => edge.from === "task-T1" && edge.to === "task-T1-acceptance")).toBe(true)
    const t2 = spec.orchestration.nodes.find((node) => node.id === "task-T2")
    expect(t2?.depends_on).toContain("task-T1-code-review")
    const finish = spec.orchestration.nodes.find((node) => node.agent === "sp-finisher" && !node.task_id)
    expect(finish?.depends_on).toEqual(["task-T1-code-review", "task-T2-code-review"])
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

  test("without task_graph, serial implement depends_on unlocks on node passed", () => {
    const decisions = decideNextDispatches(
      state({
        entrypoint: "implement",
        mode: "execute",
        current_phase: "implementation-complete",
        workflow_spec: {
          id: "run-spec-workflow-spec",
          kind: "orchestration",
          title: "Serial implements",
          auto_expansion: { allow: false, source: "controller_override", reason: "bounded" },
          orchestration: {
            nodes: [
              {
                id: "implement-t71",
                agent: "sp-implementer",
                phase: "implement",
                task_id: "t07-1",
                depends_on: [],
                report_contract: ["sp_report"],
              },
              {
                id: "implement-t72",
                agent: "sp-implementer",
                phase: "implement",
                task_id: "t07-2",
                depends_on: ["implement-t71"],
                report_contract: ["sp_report"],
              },
              {
                id: "acceptance-phase7",
                agent: "sp-acceptance-reviewer",
                phase: "acceptance",
                depends_on: ["implement-t72"],
                report_contract: ["sp_report"],
              },
            ],
            edges: [
              { from: "implement-t71", to: "implement-t72", condition: "passed" },
              { from: "implement-t72", to: "acceptance-phase7", condition: "passed" },
            ],
          },
          created_at: "2026-07-17T00:00:00.000Z",
          updated_at: "2026-07-17T00:00:00.000Z",
        },
        node_runs: [
          {
            id: "implement-t71",
            task_id: "t07-1",
            phase: "implement",
            agent: "sp-implementer",
            session_id: "session-t71",
            status: "passed",
            attempts: 1,
            started_at: "2026-07-17T00:00:00.000Z",
          },
        ],
      }),
      {
        event: "implementation",
        status: "passed",
        summary: "T7.1 done.",
        artifacts: { implementation: "skeleton landed" },
      },
    )

    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      action: "create_session",
      agent: "sp-implementer",
      phase: "implement",
      task_id: "t07-2",
    })
  })
})
