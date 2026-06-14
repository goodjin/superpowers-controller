import { describe, expect, test } from "bun:test"
import { routeWorkflow } from "../src/router/route"
import type { WorkflowState } from "../src/state/types"

const baseState: WorkflowState = {
  id: "run-1",
  project: "/repo",
  session: "session-1",
  parent_session_id: "session-1",
  workflow: "feature",
  entrypoint: "feature",
  limited_context: false,
  mode: "design",
  phase: "awaiting-approval",
  current_phase: "awaiting-approval",
  status: "running",
  goal: "build a plugin",
  created_at: "2026-06-09T00:00:00.000Z",
  updated_at: "2026-06-09T00:00:00.000Z",
  gates: {},
  artifacts: {},
  node_runs: [],
  history: [],
  next: "Ask the user to approve the design.",
}

describe("routeWorkflow", () => {
  test("explicit slash command wins over classification", () => {
    const route = routeWorkflow({ request: "fix a crash", command: "/sp-plan" })

    expect(route.mode).toBe("plan")
    expect(route.agent).toBe("sp-planner")
    expect(route.skills).toContain("superpowers-writing-plans")
  })

  test("current active state wins when waiting on a gate", () => {
    const route = routeWorkflow({
      request: "continue",
      currentState: baseState,
    })

    expect(route.mode).toBe("design")
    expect(route.phase).toBe("awaiting-approval")
    expect(route.reason).toContain("active workflow")
  })

  test("bug language routes to debug", () => {
    const route = routeWorkflow({ request: "the build fails with an unexpected crash" })

    expect(route.mode).toBe("debug")
    expect(route.agent).toBe("sp-debugger")
    expect(route.required_gates).toContain("root_cause_found")
  })

  test("implementation language routes to design", () => {
    const route = routeWorkflow({ request: "add support for workflow gates" })

    expect(route.mode).toBe("design")
    expect(route.agent).toBe("sp-designer")
    expect(route.required_gates).toContain("design_approved")
  })

  test("parallel language routes to parallel investigation", () => {
    const route = routeWorkflow({ request: "investigate frontend and backend failures in parallel" })

    expect(route.mode).toBe("parallel-investigate")
    expect(route.agent).toBe("sp-investigator")
    expect(route.skills).toContain("superpowers-dispatching-parallel-agents")
  })

  test("low confidence request routes to clarify", () => {
    const route = routeWorkflow({ request: "hmm maybe later" })

    expect(route.mode).toBe("idle")
    expect(route.phase).toBe("clarify")
    expect(route.agent).toBe("super-agent")
  })
})
