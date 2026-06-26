import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildWorkflowProposal } from "../src/controller/proposal"
import { prepareStartRun } from "../src/controller/intake"
import { createProjectStore } from "../src/state/store"
import { createPrepareTool } from "../src/tools/sp-prepare"
import { createStartTool } from "../src/tools/sp-start"
import { createCancelTool } from "../src/tools/sp-cancel"

const toolContext = {
  sessionID: "session-main",
  messageID: "message-1",
  agent: "super-agent",
  directory: "/repo",
  worktree: "/repo",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
}

describe("workflow proposal", () => {
  test("builds a feature proposal from an implementation request", () => {
    const proposal = buildWorkflowProposal({
      request: "Add workflow gates",
      routeHint: "feature",
      existingState: null,
    })

    expect(proposal.workflow).toBe("feature")
    expect(proposal.entrypoint).toBe("feature")
    expect(proposal.requires_confirmation).toBe(true)
    expect(proposal.markdown).toContain("feature workflow")
    expect(proposal.next_action).toBe("confirm_prepare")
  })

  test("builds a resume proposal when an active run exists", () => {
    const proposal = buildWorkflowProposal({
      request: "continue",
      existingState: {
        id: "run-1",
        project: "/repo",
        session: "session-main",
        parent_session_id: "session-main",
        activation: "active",
        workflow: "feature",
        entrypoint: "feature",
        limited_context: false,
        mode: "design",
        phase: "plan-complete",
        current_phase: "plan-complete",
        status: "running",
        goal: "Add workflow gates",
        created_at: "2026-06-14T00:00:00.000Z",
        updated_at: "2026-06-14T00:00:00.000Z",
        gates: { plan_written: true },
        artifacts: {},
        node_runs: [],
        history: [],
      },
    })

    expect(proposal.workflow).toBe("feature")
    expect(proposal.next_action).toBe("confirm_resume")
    expect(proposal.markdown).toContain("plan-complete")
  })
})

describe("controller intake", () => {
  test("prepares start input with request and proposal markdown", () => {
    const proposal = buildWorkflowProposal({
      request: "Add workflow gates",
      routeHint: "feature",
      existingState: null,
    })

    const start = prepareStartRun({
      request: "Add workflow gates",
      proposal,
      parentSessionID: "session-main",
    })

    expect(start.workflow).toBe("feature")
    expect(start.request).toContain("Add workflow gates")
    expect(start.proposal).toContain("feature workflow")
  })
})

describe("sp_prepare and sp_start tools", () => {
  test("sp_start reports that a confirmed workflow run started", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-progress-"))
    try {
      const store = createProjectStore(project)
      const progress: Array<{ stage: string; message: string }> = []
      const start = createStartTool(store, undefined, {
        async report(input) {
          progress.push({ stage: input.stage, message: input.message })
        },
      })

      await start.execute(
        {
          request: "Add workflow gates",
          workflow: "feature",
          entrypoint: "feature",
          proposal: "# Proposal\n\nRun feature workflow.",
        },
        toolContext,
      )

      expect(progress).toEqual([
        {
          stage: "run_started",
          message: "feature workflow run started from feature.",
        },
      ])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_prepare creates a prepared workflow without dispatching node work", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-prepare-"))
    try {
      const store = createProjectStore(project)
      const prepare = createPrepareTool(
        store,
        {
          async dispatch() {
            return {
              action: "create_session",
              session_id: "session-planner",
              task_markdown: "# Planner task",
            }
          },
        },
      )

      const output = await prepare.execute(
        {
          request: "Add workflow gates",
          workflow: "feature",
          entrypoint: "feature",
          proposal: "# Proposal\n\nPrepare feature workflow.",
        },
        toolContext,
      )

      const result = JSON.parse(toolOutput(output))
      expect(result.state.activation).toBe("draft")
      expect(result.state.current_phase).toBe("plan")
      expect(store.readCurrent()?.node_runs).toEqual([])
      expect(result.next).toContain("sp_start")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start creates a run and writes request, proposal, and changelog files", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-"))
    try {
      const store = createProjectStore(project)
      const start = createStartTool(store)

      const output = await start.execute(
        {
          request: "Add workflow gates",
          workflow: "feature",
          entrypoint: "feature",
          proposal: "# Proposal\n\nRun feature workflow.",
        },
        toolContext,
      )

      const state = JSON.parse(toolOutput(output)).state
      const runRoot = join(store.root, "runs", state.id)
      expect(store.readCurrent()?.id).toBe(state.id)
      expect(readFileSync(join(runRoot, "request.md"), "utf8")).toContain("Add workflow gates")
      expect(readFileSync(join(runRoot, "proposal.md"), "utf8")).toContain("Run feature workflow")
      expect(readFileSync(join(runRoot, "changelog.md"), "utf8")).toContain("created")
      expect(existsSync(join(runRoot, "artifacts"))).toBe(true)
      expect(existsSync(join(runRoot, "nodes"))).toBe(true)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start activates a prepared run and dispatches approved tasks", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-activate-"))
    try {
      const store = createProjectStore(project)
      const prepared = store.prepareRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add workflow gates",
        request: "# Request\n\nAdd workflow gates.",
        proposal: "# Proposal\n\nPrepare feature workflow.",
        parentSessionID: "session-main",
      })
      store.recordNodeResult({
        input: {
          event: "plan",
          status: "passed",
          summary: "Plan ready.",
          artifacts: { plan: "# Plan" },
          gates: { plan_written: true },
          task_graph: {
            tasks: [{ id: "T1", title: "Gate types", summary: "Add gate types", depends_on: [] }],
          },
        },
      })

      const start = createStartTool(
        store,
        {
          async dispatch() {
            return {
              action: "create_session",
              session_id: "session-impl",
              task_markdown: "# Implement task",
            }
          },
        },
      )

      const output = await start.execute(
        {
          run_id: prepared.id,
        },
        toolContext,
      )

      const result = JSON.parse(toolOutput(output))
      expect(result.state.activation).toBe("active")
      expect(result.dispatches).toEqual([
        {
          action: "create_session",
          phase: "implement",
          agent: "sp-implementer",
          task_id: "T1",
          session_id: "session-impl",
        },
      ])
      expect(store.readCurrent()?.node_runs.some((run) => run.agent === "sp-implementer")).toBe(true)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start resume preserves waiting-user workflows without dispatching", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-resume-waiting-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add workflow gates",
        request: "# Request\n\nAdd workflow gates.",
        proposal: "# Proposal\n\nRun feature workflow.",
        parentSessionID: "session-main",
      })
      store.recordNodeResult({
        input: {
          event: "question",
          status: "needs_user",
          summary: "Need user choice.",
          question: {
            prompt: "Use strict gates?",
            options: [{ label: "Strict", description: "Block risky writes." }],
          },
        },
      })
      const start = createStartTool(store, {
        async dispatch() {
          throw new Error("unexpected dispatch")
        },
      })

      const output = await start.execute({ run_id: state.id }, toolContext)
      const result = JSON.parse(toolOutput(output))

      expect(result.state.status).toBe("waiting_user")
      expect(result.state.pending_question.prompt).toContain("strict")
      expect(result.dispatches).toEqual([{ action: "wait_user", reason: "workflow is waiting for user input" }])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start resume does not duplicate an already running node", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-resume-running-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add workflow gates",
        request: "# Request\n\nAdd workflow gates.",
        proposal: "# Proposal\n\nRun feature workflow.",
        parentSessionID: "session-main",
      })
      store.addNodeRun({
        phase: "design",
        agent: "sp-designer",
        primary_skill: "superpowers-brainstorming",
        session_id: "session-design",
        task_markdown: "# Design task",
      })
      const start = createStartTool(store, {
        async dispatch() {
          throw new Error("unexpected duplicate dispatch")
        },
      })

      const output = await start.execute({ run_id: state.id }, toolContext)
      const result = JSON.parse(toolOutput(output))

      expect(result.dispatches).toEqual([])
      expect(store.readCurrent()?.node_runs).toHaveLength(1)
      expect(store.readCurrent()?.node_runs[0]?.session_id).toBe("session-design")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start resume does not restart a canceled workflow from entrypoint", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-resume-canceled-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add workflow gates",
        request: "# Request\n\nAdd workflow gates.",
        proposal: "# Proposal\n\nRun feature workflow.",
        parentSessionID: "session-main",
      })
      await createCancelTool(store).execute({ workflow_id: state.id, reason: "Stop this workflow." }, toolContext)
      const start = createStartTool(store, {
        async dispatch() {
          throw new Error("canceled workflow should not dispatch")
        },
      })

      const output = await start.execute({ run_id: state.id }, toolContext)
      const result = JSON.parse(toolOutput(output))

      expect(result.state.status).toBe("canceled")
      expect(result.dispatches).toEqual([{ action: "blocked", reason: "workflow is canceled" }])
      expect(store.readCurrent()?.node_runs).toEqual([])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start resume dispatches finisher after all task checks pass", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-resume-finish-"))
    try {
      const store = createProjectStore(project)
      const state = createCheckedFeatureTask(store)
      const start = createStartTool(store, {
        async dispatch(args) {
          return {
            action: args.decision.action,
            session_id: "session-finish",
            task_markdown: "# Finish task",
          }
        },
      })

      const output = await start.execute({ run_id: state.id }, toolContext)
      const result = JSON.parse(toolOutput(output))

      expect(result.dispatches).toEqual([
        {
          action: "create_session",
          phase: "finish",
          agent: "sp-finisher",
          session_id: "session-finish",
        },
      ])
      expect(store.readCurrent()?.node_runs.at(-1)).toMatchObject({
        phase: "finish",
        agent: "sp-finisher",
        status: "running",
      })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start resume redispatches a blocked finish node instead of returning to entrypoint", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-resume-finish-blocked-"))
    try {
      const store = createProjectStore(project)
      const state = createCheckedFeatureTask(store)
      const finish = store.addNodeRun({
        phase: "finish",
        agent: "sp-finisher",
        primary_skill: "superpowers-finishing-a-development-branch",
        session_id: "session-finish-old",
        task_markdown: "# Finish task",
      })
      store.cancel({ sessionID: finish.session_id, reason: "Finish session stalled." })
      const start = createStartTool(store, {
        async dispatch(args) {
          return {
            action: args.decision.action,
            session_id: "session-finish-new",
            task_markdown: "# Finish retry task",
          }
        },
      })

      const output = await start.execute({ run_id: state.id }, toolContext)
      const result = JSON.parse(toolOutput(output))

      expect(result.dispatches).toEqual([
        {
          action: "create_session",
          phase: "finish",
          agent: "sp-finisher",
          session_id: "session-finish-new",
        },
      ])
      expect(store.readCurrent()?.node_runs.map((run) => run.session_id)).toContain("session-finish-old")
      expect(store.readCurrent()?.node_runs.at(-1)?.session_id).toBe("session-finish-new")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start resume redispatches a finish node reported as blocked", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-resume-finish-report-blocked-"))
    try {
      const store = createProjectStore(project)
      const state = createCheckedFeatureTask(store)
      const finish = store.addNodeRun({
        phase: "finish",
        agent: "sp-finisher",
        primary_skill: "superpowers-finishing-a-development-branch",
        session_id: "session-finish-old",
        task_markdown: "# Finish task",
      })
      store.recordNodeResult({
        nodeID: finish.id,
        input: {
          event: "finish",
          status: "blocked",
          summary: "Finish needs a retry.",
        },
      })
      const start = createStartTool(store, {
        async dispatch(args) {
          return {
            action: args.decision.action,
            session_id: "session-finish-new",
            task_markdown: "# Finish retry task",
          }
        },
      })

      const output = await start.execute({ run_id: state.id }, toolContext)
      const result = JSON.parse(toolOutput(output))

      expect(result.dispatches).toEqual([
        {
          action: "create_session",
          phase: "finish",
          agent: "sp-finisher",
          session_id: "session-finish-new",
        },
      ])
      expect(store.readCurrent()?.status).toBe("running")
      expect(store.readCurrent()?.node_runs.at(-1)?.session_id).toBe("session-finish-new")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

function createCheckedFeatureTask(store: ReturnType<typeof createProjectStore>) {
  const state = store.startRun({
    workflow: "feature",
    entrypoint: "feature",
    goal: "Add workflow gates",
    request: "# Request\n\nAdd workflow gates.",
    proposal: "# Proposal\n\nRun feature workflow.",
    parentSessionID: "session-main",
  })
  store.recordNodeResult({
    input: {
      event: "plan",
      status: "passed",
      summary: "Plan ready.",
      artifacts: { plan: "# Plan" },
      gates: { plan_written: true },
      task_graph: {
        tasks: [{ id: "T1", title: "Gate types", summary: "Add gate types", depends_on: [] }],
      },
    },
  })
  recordTaskNode(store, "implement", "sp-implementer", "session-impl", {
    event: "implementation",
    status: "passed",
    summary: "Implemented T1.",
    artifacts: { patch_summary: "Patch summary." },
    gates: { implementation_done: true },
  })
  recordTaskNode(store, "acceptance", "sp-acceptance-reviewer", "session-acceptance", {
    event: "acceptance",
    status: "passed",
    summary: "Acceptance passed.",
    artifacts: { acceptance: "Accepted." },
    gates: { acceptance_passed: true },
  })
  recordTaskNode(store, "verification", "sp-verifier", "session-verification", {
    event: "verification",
    status: "passed",
    summary: "Verification passed.",
    artifacts: { verification_log: "Tests passed." },
    gates: { verification_fresh: true },
  })
  recordTaskNode(store, "code-review", "sp-code-reviewer", "session-review", {
    event: "code-review",
    status: "passed",
    summary: "Code review passed.",
    artifacts: { code_review: "No issues." },
    gates: { code_review_passed: true },
  })
  return state
}

function recordTaskNode(
  store: ReturnType<typeof createProjectStore>,
  phase: string,
  agent: string,
  sessionID: string,
  input: Parameters<ReturnType<typeof createProjectStore>["recordNodeResult"]>[0]["input"],
) {
  const node = store.addNodeRun({
    phase,
    agent,
    primary_skill: "primary-skill",
    session_id: sessionID,
    task_id: "T1",
    task_markdown: `# ${phase}`,
  })
  store.recordNodeResult({ nodeID: node.id, input })
}

function toolOutput(value: unknown): string {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && "output" in value) return String((value as { output: unknown }).output)
  return String(value)
}
