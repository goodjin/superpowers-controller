import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createSessionOrchestrator } from "../src/session/orchestrator"
import { buildChildRequestId, buildNodeTaskPrompt } from "../src/session/templates"

function withTimeout<T>(promise: Promise<T>, ms = 50): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for nonblocking dispatch")), ms)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

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

  test("adds a stable child request marker when e2e child prompts are enabled", () => {
    process.env.OPENCODE_SUPERPOWERS_E2E_CHILD_REQUEST_MARKERS = "1"
    try {
      const prompt = buildNodeTaskPrompt({
        run_id: "run-1",
        node_id: "001-plan-draft",
        workflow: "feature",
        phase: "plan",
        agent: "sp-planner",
        primary_skill: "superpowers-writing-plans",
        objective: "Write plan.",
        required_artifacts: [{ name: "request", path: "request.md" }],
        record_contract: {
          event: "plan",
          expected_artifacts: ["plan"],
          allowed_gates: ["plan_written"],
        },
      })

      expect(prompt).toContain(`[llm_request_id:${buildChildRequestId("001-plan-draft")}]`)
    } finally {
      delete process.env.OPENCODE_SUPERPOWERS_E2E_CHILD_REQUEST_MARKERS
    }
  })
})

describe("createSessionOrchestrator", () => {
  test("inlines required artifact bodies into dispatched node prompts", async () => {
    const project = join(tmpdir(), `sp-inline-artifacts-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const runID = "run-inline"
    const runRoot = join(project, ".opencode", "superpowers", "runs", runID)
    mkdirSync(join(runRoot, "artifacts"), { recursive: true })
    writeFileSync(join(runRoot, "request.md"), "# Request\n\nBuild a computer-use agent.\n")
    writeFileSync(join(runRoot, "artifacts", "plan.md"), "# Plan\n\nImplement T01 first.\n")

    try {
      const prompts: string[] = []
      const orchestrator = createSessionOrchestrator({
        async createNodeSession() {
          return "session-node"
        },
        async continueNodeSession(input) {
          prompts.push(input.prompt)
        },
        async showProgress() {},
      })

      await orchestrator.dispatch({
        project,
        runID,
        parentSessionID: "session-main",
        decision: {
          action: "create_session",
          phase: "plan",
          agent: "sp-planner",
          primary_skill: "superpowers-writing-plans",
          reason: "plan next",
        },
        packet: {
          run_id: runID,
          node_id: "001-plan",
          workflow: "feature",
          phase: "plan",
          agent: "sp-planner",
          primary_skill: "superpowers-writing-plans",
          objective: "Write plan.",
          required_artifacts: [
            { name: "request", path: "request.md" },
            { name: "plan", path: "artifacts/plan.md" },
          ],
          record_contract: { event: "plan", expected_artifacts: ["plan"], allowed_gates: ["plan_written"] },
        },
      })

      expect(prompts[0]).toContain("## Source Artifacts")
      expect(prompts[0]).toContain("### request: request.md")
      expect(prompts[0]).toContain("Build a computer-use agent.")
      expect(prompts[0]).toContain("### plan: artifacts/plan.md")
      expect(prompts[0]).toContain("Implement T01 first.")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("creates a node session and returns the rendered task packet", async () => {
    const calls: Array<{ stage: "create" | "prompt"; agent: string; prompt?: string }> = []
    const progress: Array<{ stage: string; message: string }> = []
    const orchestrator = createSessionOrchestrator({
      async createNodeSession(input) {
        calls.push({ stage: "create", agent: input.agent })
        return "session-node"
      },
      async continueNodeSession(input) {
        calls.push({ stage: "prompt", agent: input.agent, prompt: input.prompt })
      },
      async showProgress(input) {
        progress.push({ stage: input.stage, message: input.message })
      },
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
    expect(calls).toEqual([
      { stage: "create", agent: "sp-designer" },
      { stage: "prompt", agent: "sp-designer", prompt: expect.stringContaining("Create design.") },
    ])
    expect(progress).toEqual([
      {
        stage: "dispatch_started",
        message: "Starting sp-designer for 001-design.",
      },
      {
        stage: "node_running",
        message: "Scheduled sp-designer for 001-design.",
      },
    ])
  })

  test("returns after scheduling a child prompt that has not completed", async () => {
    const prompts: string[] = []
    const progress: Array<{ stage: string; message: string }> = []
    const orchestrator = createSessionOrchestrator({
      async createNodeSession() {
        return "session-node"
      },
      async continueNodeSession(input) {
        prompts.push(input.sessionID)
        return new Promise<void>(() => {})
      },
      async showProgress(input) {
        progress.push({ stage: input.stage, message: input.message })
      },
    })

    const result = await withTimeout(orchestrator.dispatch({
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
    }))

    expect(result).toMatchObject({ action: "create_session", session_id: "session-node" })
    expect(prompts).toEqual(["session-node"])
    expect(progress).toEqual([
      {
        stage: "dispatch_started",
        message: "Starting sp-designer for 001-design.",
      },
      {
        stage: "node_running",
        message: "Scheduled sp-designer for 001-design.",
      },
    ])
  })

  test("registers a created node before sending the first child prompt", async () => {
    const order: string[] = []
    const orchestrator = createSessionOrchestrator({
      async createNodeSession() {
        order.push("create")
        return "session-node"
      },
      async continueNodeSession() {
        order.push("prompt")
      },
      async showProgress() {},
    })

    await orchestrator.dispatch({
      project: "/repo",
      runID: "run-1",
      parentSessionID: "session-main",
      decision: {
        action: "create_session",
        phase: "plan",
        agent: "sp-planner",
        primary_skill: "superpowers-writing-plans",
        reason: "plan next",
      },
      packet: {
        run_id: "run-1",
        node_id: "001-plan",
        workflow: "feature",
        phase: "plan",
        agent: "sp-planner",
        primary_skill: "superpowers-writing-plans",
        objective: "Write plan.",
        required_artifacts: [],
        record_contract: { event: "plan", expected_artifacts: ["plan"], allowed_gates: ["plan_written"] },
      },
      async onSessionCreated() {
        order.push("register")
      },
    })

    expect(order).toEqual(["create", "register", "prompt"])
  })

  test("selects serial design and plan children in the foreground", async () => {
    const selected: string[] = []
    const orchestrator = createSessionOrchestrator({
      async createNodeSession(input) {
        return `session-${input.agent}`
      },
      async continueNodeSession() {},
      async selectSession(input) {
        selected.push(input.sessionID)
      },
      async showProgress() {},
    })

    await orchestrator.dispatch({
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

    expect(selected).toEqual(["session-sp-designer"])
  })

  test("selects implement children in the foreground", async () => {
    const selected: string[] = []
    const orchestrator = createSessionOrchestrator({
      async createNodeSession() {
        return "session-implement"
      },
      async continueNodeSession() {},
      async selectSession(input) {
        selected.push(input.sessionID)
      },
      async showProgress() {},
    })

    await orchestrator.dispatch({
      project: "/repo",
      runID: "run-1",
      parentSessionID: "session-main",
      decision: {
        action: "create_session",
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        task_id: "T1",
        reason: "task runnable",
      },
      packet: {
        run_id: "run-1",
        node_id: "001-implement-T1",
        workflow: "feature",
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        task_id: "T1",
        objective: "Implement T1.",
        required_artifacts: [],
        record_contract: { event: "implementation", expected_artifacts: ["patch_summary"], allowed_gates: ["implementation_done"] },
      },
    })

    expect(selected).toEqual(["session-implement"])
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

  test("resumeNode selects the resumed child session in the foreground", async () => {
    const selected: string[] = []
    const orchestrator = createSessionOrchestrator({
      async createNodeSession() {
        throw new Error("unexpected create")
      },
      async continueNodeSession() {},
      async selectSession(input) {
        selected.push(input.sessionID)
      },
      async showProgress() {},
    })

    await orchestrator.resumeNode({
      sessionID: "session-design",
      agent: "sp-designer",
      prompt: "User answered the pending question.",
      phase: "design",
    })

    expect(selected).toEqual(["session-design"])
  })

  test("resumeNode returns after scheduling a prompt that has not completed", async () => {
    const prompts: string[] = []
    const orchestrator = createSessionOrchestrator({
      async createNodeSession() {
        throw new Error("unexpected create")
      },
      async continueNodeSession(input) {
        prompts.push(input.sessionID)
        return new Promise<void>(() => {})
      },
      async showProgress() {},
    })

    const result = await withTimeout(orchestrator.resumeNode({
      sessionID: "session-design",
      agent: "sp-designer",
      prompt: "User answered the pending question.",
    }))

    expect(result).toEqual({
      action: "resume_session",
      session_id: "session-design",
    })
    expect(prompts).toEqual(["session-design"])
  })

  test("notifyParent returns after scheduling a parent prompt that has not completed", async () => {
    const prompts: string[] = []
    const orchestrator = createSessionOrchestrator({
      async createNodeSession() {
        throw new Error("unexpected create")
      },
      async continueNodeSession(input) {
        prompts.push(input.sessionID)
        return new Promise<void>(() => {})
      },
      async showProgress() {},
    })

    await withTimeout(orchestrator.notifyParent({
      sessionID: "session-main",
      agent: "superpowers-agent",
      prompt: "Workflow is waiting for user input.",
    }))

    expect(prompts).toEqual(["session-main"])
  })
})
