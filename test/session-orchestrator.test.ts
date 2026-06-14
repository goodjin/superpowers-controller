import { describe, expect, test } from "bun:test"
import { createSessionOrchestrator } from "../src/session/orchestrator"
import { buildNodeTaskPrompt } from "../src/session/templates"

describe("buildNodeTaskPrompt", () => {
  test("builds implement task prompt with one primary skill and record contract", () => {
    const prompt = buildNodeTaskPrompt({
      run_id: "run-1",
      node_id: "004-implement-T1",
      workflow: "feature",
      phase: "implement",
      agent: "sp-implementer",
      primary_skill: "superpowers-test-driven-development",
      objective: "Implement T1.",
      required_artifacts: [{ name: "plan", path: "artifacts/plan.md" }],
      record_contract: {
        event: "implementation",
        expected_artifacts: ["patch_summary"],
        allowed_gates: ["implementation_done"],
      },
    })

    expect(prompt).toContain("Primary skill: superpowers-test-driven-development")
    expect(prompt).not.toContain("supporting_skills")
    expect(prompt).toContain("Do not include next_action")
    expect(prompt).toContain("artifacts/plan.md")
  })
})

describe("createSessionOrchestrator", () => {
  test("creates a node session and returns the rendered task packet", async () => {
    const calls: Array<{ agent: string; prompt: string }> = []
    const orchestrator = createSessionOrchestrator({
      async createNodeSession(input) {
        calls.push({ agent: input.agent, prompt: input.prompt })
        return "session-node"
      },
      async continueNodeSession() {
        throw new Error("unexpected reuse")
      },
      async showProgress() {},
    })

    const result = await orchestrator.dispatch({
      project: "/repo",
      runID: "run-1",
      parentSessionID: "session-main",
      decision: {
        action: "create_session",
        phase: "design",
        agent: "sp-designer",
        primary_skill: "superpowers-brainstorming",
        reason: "design next",
      },
      packet: {
        run_id: "run-1",
        node_id: "001-design",
        workflow: "feature",
        phase: "design",
        agent: "sp-designer",
        primary_skill: "superpowers-brainstorming",
        objective: "Create design.",
        required_artifacts: [],
        record_contract: { event: "design", expected_artifacts: ["spec"], allowed_gates: ["spec_written"] },
      },
    })

    expect(result).toMatchObject({ action: "create_session", session_id: "session-node" })
    expect(result.task_markdown).toContain("Primary skill: superpowers-brainstorming")
    expect(calls[0]?.agent).toBe("sp-designer")
    expect(calls[0]?.prompt).toContain("Create design.")
  })

  test("reuses an existing node session for retry dispatch", async () => {
    const continued: string[] = []
    const orchestrator = createSessionOrchestrator({
      async createNodeSession() {
        throw new Error("unexpected create")
      },
      async continueNodeSession(input) {
        continued.push(input.sessionID)
      },
      async showProgress() {},
    })

    const result = await orchestrator.dispatch({
      project: "/repo",
      runID: "run-1",
      parentSessionID: "session-main",
      decision: {
        action: "reuse_session",
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-impl",
        task_id: "T1",
        reason: "retry",
      },
      packet: {
        run_id: "run-1",
        node_id: "005-implement-T1-retry",
        workflow: "feature",
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        task_id: "T1",
        objective: "Fix review findings.",
        required_artifacts: [],
        retry_context: "Missing edge case.",
        record_contract: { event: "implementation", expected_artifacts: ["patch_summary"], allowed_gates: ["implementation_done"] },
      },
    })

    expect(result).toMatchObject({ action: "reuse_session", session_id: "session-impl" })
    expect(continued).toEqual(["session-impl"])
  })
})
