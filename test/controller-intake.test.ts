import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildWorkflowProposal } from "../src/controller/proposal"
import { prepareStartRun } from "../src/controller/intake"
import { createSessionOrchestrator } from "../src/session/orchestrator"
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

function withTimeout<T>(promise: Promise<T>, ms = 50): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for nonblocking tool result")), ms)
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

  test("sp_prepare creates a managed design draft and dispatches the designer node", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-prepare-"))
    try {
      const store = createProjectStore(project)
      const prepare = createPrepareTool(
        store,
        {
          async dispatch() {
            return {
              action: "create_session",
              session_id: "session-designer",
              task_markdown: "# Designer task",
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
      expect(result.prepare_mode).toBe("managed_design")
      expect(result.state.current_phase).toBe("design")
      expect(result.dispatches).toEqual([
        {
          action: "create_session",
          phase: "design",
          agent: "sp-designer",
          task_id: undefined,
          session_id: "session-designer",
        },
      ])
      expect(store.readCurrent()?.node_runs.at(-1)).toMatchObject({
        phase: "design",
        agent: "sp-designer",
        session_id: "session-designer",
        status: "running",
      })
      expect(result.next).toContain("approve_design")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_prepare accepts v5 task brief and sp_start writes workflow spec from start_config", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-v5-prepare-start-"))
    try {
      const store = createProjectStore(project)
      const dispatched: Array<{ agent: string; phase: string }> = []
      const prepare = createPrepareTool(
        store,
        {
          async dispatch(args) {
            dispatched.push({ agent: args.decision.agent, phase: args.decision.phase })
            return {
              action: "create_session",
              session_id: "session-unused",
              task_markdown: "# Unused",
            }
          },
        },
      )

      const preparedOutput = await prepare.execute(
        {
          task_brief: {
            goal: "Update controller prompt",
            scope: "Prompt and tests only",
            constraints: "Keep public tools unchanged",
            acceptance_criteria: "Greeting rule is present",
            known_context: "v5 PRD",
          },
          kind: "single-agent",
          entrypoint: "implement",
          design_participation: {
            mode: "none",
            reason: "The task is scoped.",
          },
          confirmation: {
            required: true,
            question: "确认按这个单节点任务执行吗？",
          },
        },
        toolContext,
      )

      const prepared = JSON.parse(toolOutput(preparedOutput))
      const runRoot = join(store.root, "runs", prepared.prepared_task_id)
      expect(prepared.prepare_mode).toBe("proposal_only")
      expect(prepared.confirmation_summary).toContain("Update controller prompt")
      expect(prepared.required_user_confirmations).toEqual(["确认按这个单节点任务执行吗？"])
      expect(dispatched).toEqual([])
      expect(existsSync(join(runRoot, "documents.json"))).toBe(true)
      const documents = readFileSync(join(runRoot, "documents.json"), "utf8")
      expect(documents).toContain("request.md")
      expect(documents).toContain("task.md")
      expect(documents).toContain("proposal.md")
      expect(readFileSync(join(runRoot, "task.md"), "utf8")).toContain("Acceptance Criteria")
      expect(readFileSync(join(runRoot, "task.md"), "utf8")).toContain("Greeting rule is present")

      const start = createStartTool(store, {
        async dispatch(args) {
          dispatched.push({ agent: args.decision.agent, phase: args.decision.phase })
          return {
            action: "create_session",
            session_id: "session-implementer",
            task_markdown: "# Implement task",
          }
        },
      })
      const startedOutput = await start.execute(
        {
          prepared_task_id: prepared.prepared_task_id,
          action: "start_prepared_task",
          start_config: {
            kind: "built_in_workflow",
            workflow_id: "single-agent",
          },
        },
        toolContext,
      )

      const started = JSON.parse(toolOutput(startedOutput))
      expect(started.state.workflow).toBe("single-agent")
      expect(started.state.workflow_spec.template_id).toBe("single-agent")
      expect(readFileSync(join(runRoot, "workflow-spec.json"), "utf8")).toContain("single-agent")
      expect(dispatched.at(-1)).toEqual({ agent: "sp-implementer", phase: "implement" })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_prepare rejects array task brief prose fields", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-v5-prepare-string-fields-"))
    try {
      const store = createProjectStore(project)
      const prepare = createPrepareTool(
        store,
        {
          async dispatch() {
            return {
              action: "create_session",
              session_id: "session-unused",
              task_markdown: "# Unused",
            }
          },
        },
      )

      await expect(prepare.execute(
        {
          task_brief: {
            goal: "Update controller prompt",
            constraints: ["Keep public tools unchanged"],
          },
        },
        toolContext,
      )).rejects.toThrow("sp_prepare task_brief.constraints must be a string.")
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

  test("v4 approval promotion keeps candidate outputs out of canonical artifacts until approval", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-v4-approval-"))
    try {
      const store = createProjectStore(project)
      const prepared = store.prepareRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add workflow gates",
        request: "# Request\n\nAdd workflow gates.",
        proposal: "# Proposal\n\nPrepare feature workflow.",
        parentSessionID: "session-main",
        prepareMode: "managed_design",
      })
      const design = store.addNodeRun({
        phase: "design",
        agent: "sp-designer",
        primary_skill: "superpowers-brainstorming",
        session_id: "session-design",
        task_markdown: "# Design task",
      })
      const afterDesign = store.recordNodeResult({
        nodeID: design.id,
        sessionID: "session-design",
        agent: "sp-designer",
        input: {
          event: "design",
          status: "passed",
          summary: "Design ready.",
          artifacts: { spec: "# Spec\n\nApproved behavior." },
          gates: { design_approved: true, spec_written: true },
        },
      })
      const runRoot = join(store.root, "runs", prepared.id)
      expect(afterDesign.status).toBe("awaiting_design_approval")
      expect(afterDesign.artifacts.spec).toBeUndefined()
      expect(existsSync(join(runRoot, "artifacts", "spec.md"))).toBe(false)
      expect(readFileSync(join(runRoot, "nodes", design.id, "record.json"), "utf8")).toContain("Approved behavior")

      const dispatched: string[] = []
      const start = createStartTool(store, {
        async dispatch(args) {
          dispatched.push(args.decision.agent)
          return {
            action: args.decision.action,
            session_id: "session-planner",
            task_markdown: "# Planner task",
          }
        },
      })
      const designApproved = JSON.parse(toolOutput(await start.execute({
        run_id: prepared.id,
        start_action: "approve_design",
        expected_state_version: afterDesign.state_version,
      }, toolContext)))
      expect(dispatched).toEqual(["sp-planner"])
      expect(designApproved.controller_feedback.artifact_mode).toBe("canonical")
      expect(readFileSync(join(runRoot, "artifacts", "spec.md"), "utf8")).toContain("Approved behavior")
      expect(readFileSync(join(runRoot, "events.jsonl"), "utf8")).toContain("design_approved")

      const planner = store.readCurrent()?.node_runs.find((run) => run.agent === "sp-planner")
      expect(planner?.session_id).toBe("session-planner")
      const afterPlan = store.recordNodeResult({
        nodeID: planner?.id,
        sessionID: "session-planner",
        agent: "sp-planner",
        input: {
          event: "plan",
          status: "passed",
          summary: "Plan ready.",
          artifacts: { plan: "# Plan\n\nImplement T1." },
          gates: { plan_written: true },
          task_graph: {
            tasks: [{ id: "T1", title: "Implement gates", summary: "Add gate implementation.", depends_on: [] }],
          },
        },
      })
      expect(afterPlan.status).toBe("awaiting_plan_approval")
      expect(afterPlan.task_graph).toBeUndefined()
      expect(existsSync(join(runRoot, "artifacts", "plan.md"))).toBe(false)

      const planApproved = JSON.parse(toolOutput(await start.execute({
        run_id: prepared.id,
        start_action: "approve_plan",
        expected_state_version: afterPlan.state_version,
      }, toolContext)))
      expect(planApproved.dispatches).toEqual([
        {
          action: "create_session",
          phase: "implement",
          agent: "sp-implementer",
          task_id: "T1",
          session_id: "session-planner",
        },
      ])
      expect(store.readCurrent()?.activation).toBe("active")
      expect(store.readCurrent()?.task_graph?.tasks[0].id).toBe("T1")
      expect(readFileSync(join(runRoot, "artifacts", "plan.md"), "utf8")).toContain("Implement T1")
      expect(readFileSync(join(runRoot, "task_graph.json"), "utf8")).toContain("Implement gates")
      expect(readFileSync(join(runRoot, "events.jsonl"), "utf8")).toContain("plan_approved")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start expected_state_version rejects stale approval without dispatching", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-v4-stale-version-"))
    try {
      const store = createProjectStore(project)
      const state = store.prepareRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add workflow gates",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
        prepareMode: "proposal_only",
      })
      const start = createStartTool(store, {
        async dispatch() {
          throw new Error("stale approval must not dispatch")
        },
      })

      const output = await start.execute({
        run_id: state.id,
        expected_state_version: "stale-version",
      }, toolContext)
      const result = JSON.parse(toolOutput(output))

      expect(result.dispatches).toEqual([])
      expect(result.controller_feedback.outcome).toBe("blocked")
      expect(result.controller_feedback.blocking_reason).toContain("stale")
      expect(store.readCurrent()?.node_runs).toEqual([])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start with execute entrypoint dispatches implementation instead of design", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-execute-entrypoint-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Implement an approved task",
        request: "# Request\n\nImplement the approved task.",
        proposal: "# Proposal\n\nRun execution workflow.",
        parentSessionID: "session-main",
      })
      const start = createStartTool(store, {
        async dispatch(args) {
          return {
            action: args.decision.action,
            session_id: "session-impl",
            task_markdown: "# Implement task",
          }
        },
      })

      const output = await start.execute({ run_id: state.id }, toolContext)
      const result = JSON.parse(toolOutput(output))

      expect(result.dispatches).toEqual([
        {
          action: "create_session",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "session-impl",
        },
      ])
      expect(store.readCurrent()?.node_runs.at(-1)).toMatchObject({
        phase: "implement",
        agent: "sp-implementer",
      })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_prepare imports source workflow task graph and artifacts", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-prepare-source-workflow-"))
    try {
      const store = createProjectStore(project)
      const source = store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Source workflow",
        request: "# Request\n\nSource workflow.",
        proposal: "# Proposal\n\nSource workflow.",
        parentSessionID: "session-main",
      })
      store.recordNodeResult({
        input: {
          event: "plan",
          status: "passed",
          summary: "Plan ready.",
          artifacts: { plan: "# Source Plan\n\nImplement source tasks." },
          gates: { plan_written: true },
          task_graph: {
            tasks: [{ id: "T1", title: "Source task", summary: "Reuse this task graph.", depends_on: [] }],
          },
        },
      })

      const prepare = createPrepareTool(store, {
        async dispatch() {
          throw new Error("prepare must not dispatch")
        },
      })
      const output = await prepare.execute(
        {
          task: "Continue from the source workflow.",
          workflow: "feature",
          entrypoint: "execute",
          source_workflow_id: source.id,
        },
        toolContext,
      )

      const result = JSON.parse(toolOutput(output))
      const current = store.readCurrent()
      const runRoot = join(store.root, "runs", result.state.id)
      expect(current?.task_graph?.tasks.map((task) => task.id)).toEqual(["T1"])
      expect(current?.artifacts.plan).toBe("plan.md")
      expect(readFileSync(join(runRoot, "artifacts", "plan.md"), "utf8")).toContain("Source Plan")
      expect(readFileSync(join(runRoot, "tasks.json"), "utf8")).toContain("Source task")
      expect(result.state.id).not.toBe(source.id)
      expect(result.state.entrypoint).toBe("execute")

      const start = createStartTool(store, {
        async dispatch(args) {
          return {
            action: args.decision.action,
            session_id: "session-source-impl",
            task_markdown: "# Implement source task",
          }
        },
      })
      const started = JSON.parse(toolOutput(await start.execute({ run_id: result.state.id }, toolContext)))
      expect(started.dispatches).toEqual([
        {
          action: "create_session",
          phase: "implement",
          agent: "sp-implementer",
          task_id: "T1",
          session_id: "session-source-impl",
        },
      ])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start approval from a foreground child preserves the original parent session", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-child-approval-parent-"))
    try {
      const store = createProjectStore(project)
      const prepared = store.prepareRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add foreground child approvals",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
        prepareMode: "proposal_only",
      })
      const design = store.addNodeRun({
        phase: "design",
        agent: "sp-designer",
        primary_skill: "superpowers-brainstorming",
        session_id: "session-design",
        task_markdown: "# Design task",
      })
      const afterDesign = store.recordNodeResult({
        nodeID: design.id,
        sessionID: "session-design",
        agent: "sp-designer",
        input: {
          event: "design",
          status: "passed",
          summary: "Design ready.",
          artifacts: { spec: "# Spec\n\nForeground approval." },
          gates: { design_approved: true, spec_written: true },
        },
      })
      const start = createStartTool(store, {
        async dispatch(args) {
          return {
            action: args.decision.action,
            session_id: "session-plan",
            task_markdown: "# Plan task",
          }
        },
      })

      const result = JSON.parse(toolOutput(await start.execute({
        run_id: prepared.id,
        start_action: "approve_design",
        expected_state_version: afterDesign.state_version,
      }, {
        ...toolContext,
        sessionID: "session-design",
      })))

      expect(result.state.parent_session_id).toBe("session-main")
      expect(store.readCurrent()?.parent_session_id).toBe("session-main")
      const events = readFileSync(join(store.root, "runs", prepared.id, "events.jsonl"), "utf8")
      expect(events).toContain('"approved_by_session_id":"session-design"')
      expect(events).toContain('"design_approved"')
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

  test("sp_start resume_input clears pending question and resumes the waiting child session", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-resume-input-"))
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
      const node = store.addNodeRun({
        phase: "design",
        agent: "sp-designer",
        primary_skill: "superpowers-brainstorming",
        session_id: "session-design",
        task_markdown: "# Design task",
      })
      store.recordNodeResult({
        input: {
          event: "design",
          status: "needs_user",
          summary: "Need user choice.",
          question: {
            prompt: "Use strict gates?",
            options: [{ label: "Strict", description: "Block risky writes." }],
          },
        },
        sessionID: "session-design",
        agent: "sp-designer",
      })
      const resumed: Array<{ sessionID: string; agent: string; prompt: string }> = []
      const start = createStartTool(store, {
        async dispatch() {
          throw new Error("unexpected dispatch")
        },
        async resumeNode(input: { sessionID: string; agent: string; prompt: string }) {
          resumed.push(input)
          return {
            action: "resume_session" as const,
            session_id: input.sessionID,
          }
        },
      } as never)

      const output = await start.execute(
        {
          run_id: state.id,
          resume_input: {
            source_node_id: node.id,
            answer_text: "Use strict gates, but keep write prompts visible.",
            selected_options: ["Strict"],
            user_message: "Strict is fine, but keep prompts visible.",
          },
        },
        toolContext,
      )
      const result = JSON.parse(toolOutput(output))

      expect(result.state.status).toBe("running")
      expect(result.state.current_phase).toBe("design")
      expect(result.state.pending_question).toBeUndefined()
      expect(result.dispatches).toEqual([
        {
          action: "resume_session",
          phase: "design",
          agent: "sp-designer",
          task_id: undefined,
          session_id: "session-design",
        },
      ])
      expect(resumed).toHaveLength(1)
      expect(resumed[0].sessionID).toBe("session-design")
      expect(resumed[0].agent).toBe("sp-designer")
      expect(resumed[0].prompt).toContain("Use strict gates?")
      expect(resumed[0].prompt).toContain("Use strict gates, but keep write prompts visible.")
      expect(resumed[0].prompt).toContain("sp_report")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start resume_input returns while the resumed child prompt is still running", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-resume-input-nonblocking-"))
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
      const node = store.addNodeRun({
        phase: "design",
        agent: "sp-designer",
        primary_skill: "superpowers-brainstorming",
        session_id: "session-design",
        task_markdown: "# Design task",
      })
      store.recordNodeResult({
        input: {
          event: "design",
          status: "needs_user",
          summary: "Need user choice.",
          question: { prompt: "Use strict gates?" },
        },
        sessionID: "session-design",
        agent: "sp-designer",
      })
      const prompts: Array<{ sessionID: string; agent: string; prompt: string }> = []
      const orchestrator = createSessionOrchestrator({
        async createNodeSession() {
          throw new Error("unexpected create")
        },
        async continueNodeSession(input) {
          prompts.push(input)
          return new Promise<void>(() => {})
        },
        async showProgress() {},
      })
      const start = createStartTool(store, orchestrator)

      const output = await withTimeout(start.execute(
        {
          run_id: state.id,
          resume_input: {
            source_node_id: node.id,
            answer_text: "Use strict gates.",
          },
        },
        toolContext,
      ))
      const result = JSON.parse(toolOutput(output))

      expect(result.state.status).toBe("running")
      expect(result.state.pending_question).toBeUndefined()
      expect(result.dispatches).toEqual([
        {
          action: "resume_session",
          phase: "design",
          agent: "sp-designer",
          task_id: undefined,
          session_id: "session-design",
        },
      ])
      expect(prompts).toHaveLength(1)
      expect(prompts[0].sessionID).toBe("session-design")
      expect(prompts[0].prompt).toContain("Use strict gates.")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start resume_input rejects answers for a different pending question", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-resume-input-mismatch-"))
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
      store.recordNodeResult({
        input: {
          event: "design",
          status: "needs_user",
          summary: "Need user choice.",
          question: { prompt: "Use strict gates?" },
        },
        sessionID: "session-design",
        agent: "sp-designer",
      })
      const start = createStartTool(store, {
        async dispatch() {
          throw new Error("unexpected dispatch")
        },
        async resumeNode() {
          throw new Error("unexpected resume")
        },
      } as never)

      await expect(start.execute(
        {
          run_id: state.id,
          resume_input: {
            source_node_id: "999-other",
            answer_text: "Use strict gates.",
          },
        },
        toolContext,
      )).rejects.toThrow("does not match the pending question")
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

  test("sp_start resume waits for user decision after startup interrupted nodes", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-recovered-unknown-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add usage records",
        request: "# Request\n\nAdd usage records.",
        proposal: "# Proposal\n\nRun feature workflow.",
        parentSessionID: "session-main",
      })
      store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-impl-old",
        task_id: "T3",
        task_markdown: "# Implement T3",
      })
      store.recoverInterruptedRunningNodes({
        reason: "Plugin process started.",
      })
      const start = createStartTool(store, {
        async dispatch() {
          throw new Error("recovered workflow should wait for user decision")
        },
      })

      const output = await start.execute({ run_id: state.id }, toolContext)
      const result = JSON.parse(toolOutput(output))

      expect(result.state.status).toBe("recovered_unknown")
      expect(result.dispatches).toEqual([
        {
          action: "blocked",
          reason: "workflow was recovered after startup and needs user confirmation before retry or cancel. Interrupted nodes: 001-implement-T3.",
        },
      ])
      expect(store.readCurrent()?.node_runs).toHaveLength(1)
      expect(store.readCurrent()?.node_runs[0]?.status).toBe("interrupted")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start resume retries a user-selected interrupted task with a new node session", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-retry-interrupted-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add usage records",
        request: "# Request\n\nAdd usage records.",
        proposal: "# Proposal\n\nRun feature workflow.",
        parentSessionID: "session-main",
      })
      const oldNode = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-impl-old",
        task_id: "T3",
        task_markdown: "# Implement T3",
      })
      store.recoverInterruptedRunningNodes({
        reason: "Plugin process started.",
      })
      const start = createStartTool(store, {
        async dispatch(args) {
          return {
            action: args.decision.action,
            session_id: "session-impl-new",
            task_markdown: "# Retry T3",
          }
        },
      })

      const output = await start.execute({ run_id: state.id, task_id: "T3" }, toolContext)
      const result = JSON.parse(toolOutput(output))

      expect(result.dispatches).toEqual([
        {
          action: "create_session",
          phase: "implement",
          agent: "sp-implementer",
          task_id: "T3",
          session_id: "session-impl-new",
        },
      ])
      const nodes = store.readCurrent()?.node_runs ?? []
      expect(nodes).toHaveLength(2)
      expect(nodes[0]).toMatchObject({
        id: oldNode.id,
        session_id: "session-impl-old",
        status: "interrupted",
      })
      expect(nodes[1]).toMatchObject({
        id: "002-implement-T3-retry-2",
        session_id: "session-impl-new",
        status: "running",
        task_id: "T3",
        attempts: 2,
      })
      expect(store.readCurrent()?.status).toBe("running")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start resolves a controller retry decision for a failed dispatch", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-controller-retry-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Retry dispatch failure",
        request: "# Request\n\nRetry dispatch failure.",
        proposal: "# Proposal\n\nRun execution workflow.",
        parentSessionID: "session-main",
      })
      const failed = store.markDispatchFailed({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        task_id: "T2",
        error: new Error("child session unavailable"),
      })
      const failedState = store.readCurrent()
      const start = createStartTool(store, {
        async dispatch(args) {
          return {
            action: args.decision.action,
            session_id: "session-impl-retry",
            task_markdown: "# Retry T2",
          }
        },
      })

      const output = await start.execute({
        run_id: state.id,
        start_action: "resolve_controller_decision",
        expected_state_version: failedState?.state_version,
        controller_decision: {
          kind: "retry_node",
          node_id: failed.id,
          task_id: "T2",
          reason: "Retry the failed implementation dispatch.",
        },
      }, toolContext)
      const result = JSON.parse(toolOutput(output))

      expect(result.dispatches).toEqual([
        {
          action: "create_session",
          phase: "implement",
          agent: "sp-implementer",
          task_id: "T2",
          session_id: "session-impl-retry",
        },
      ])
      const nodes = store.readCurrent()?.node_runs ?? []
      expect(nodes[0]).toMatchObject({
        id: failed.id,
        status: "dispatch_failed",
      })
      expect(nodes[1]).toMatchObject({
        id: "002-implement-T2-retry-2",
        status: "running",
        session_id: "session-impl-retry",
        attempts: 2,
      })
      expect(store.readCurrent()?.status).toBe("running")
      expect(readFileSync(join(store.root, "runs", state.id, "events.jsonl"), "utf8")).toContain("controller_decision_retry_node")
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
