import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config/defaults"
import { createSessionOrchestrator } from "../src/session/orchestrator"
import { buildNodeTaskPrompt } from "../src/session/templates"
import { createProjectStore } from "../src/state/store"
import { createReportHandler } from "../src/tools/report-handler"
import { createWorkflowSpec } from "../src/capabilities/workflows"

function withTimeout<T>(promise: Promise<T>, ms = 50): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for nonblocking report")), ms)
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

describe("sp_report dispatch integration", () => {
  test("workflow expansion waits for controller decision when auto expansion is disabled", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-expansion-wait-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "single-agent",
        entrypoint: "implement",
        goal: "One bounded task",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      store.setWorkflowSpec({
        runID: state.id,
        parentSessionID: "session-main",
        workflowSpec: createWorkflowSpec({
          id: `${state.id}-workflow-spec`,
          kind: "orchestration",
          title: "Bounded single node",
          autoExpansionAllow: false,
          orchestration: {
            nodes: [{ id: "01-implement", agent: "sp-implementer", phase: "implement" }],
          },
        }),
      })
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch() {
            throw new Error("should not dispatch while waiting for controller decision")
          },
        },
      })

      const output = await handler({
        event: "plan",
        status: "passed",
        summary: "Planner proposed extra work.",
        artifacts: { plan: "# Plan" },
        gates: { plan_written: true },
        workflow_expansion: {
          reason: "Need one follow-up task.",
          tasks: [{ id: "T1", title: "Follow-up", summary: "Do follow-up", depends_on: [] }],
        },
      })

      const result = JSON.parse(output)
      expect(result.state.status).toBe("waiting_controller_decision")
      expect(result.controller_feedback.allowed_controller_decisions.map((item: { kind: string }) => item.kind)).toContain("apply_workflow_patch")
      expect(store.readCurrent()?.pending_workflow_expansion?.tasks?.[0].id).toBe("T1")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("workflow expansion waiting for controller decision notifies the parent session", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-expansion-notify-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "single-agent",
        entrypoint: "implement",
        goal: "One bounded task",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      store.setWorkflowSpec({
        runID: state.id,
        parentSessionID: "session-main",
        workflowSpec: createWorkflowSpec({
          id: `${state.id}-workflow-spec`,
          kind: "orchestration",
          title: "Bounded single node",
          autoExpansionAllow: false,
          orchestration: {
            nodes: [{ id: "01-implement", agent: "sp-implementer", phase: "implement" }],
          },
        }),
      })
      const notifications: Array<{ sessionID: string; agent: string; prompt: string }> = []
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch() {
            throw new Error("should not dispatch while waiting for controller decision")
          },
          async notifyParent(input: { sessionID: string; agent: string; prompt: string }) {
            notifications.push(input)
          },
        } as never,
      })

      await handler({
        event: "plan",
        status: "passed",
        summary: "Planner proposed extra work.",
        artifacts: { plan: "# Plan" },
        gates: { plan_written: true },
        workflow_expansion: {
          reason: "Need one follow-up task.",
          tasks: [{ id: "T1", title: "Follow-up", summary: "Do follow-up", depends_on: [] }],
        },
      })

      expect(store.readCurrent()?.status).toBe("waiting_controller_decision")
      expect(notifications).toHaveLength(1)
      expect(notifications[0].sessionID).toBe("session-main")
      expect(notifications[0].agent).toBe("superpowers-agent")
      expect(notifications[0].prompt).toContain("waiting for controller decision")
      expect(notifications[0].prompt).toContain("sp_status")
      expect(notifications[0].prompt).toContain("sp_start")
      expect(notifications[0].prompt).toContain("resolve_controller_decision")
      expect(notifications[0].prompt).toContain("apply_workflow_patch")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("workflow expansion creates runnable tasks when auto expansion is allowed", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-expansion-apply-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "plan",
        goal: "Expanded feature",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      store.setWorkflowSpec({
        runID: state.id,
        parentSessionID: "session-main",
        workflowSpec: createWorkflowSpec({
          id: `${state.id}-workflow-spec`,
          kind: "orchestration",
          title: "Expandable",
          autoExpansionAllow: true,
          orchestration: {
            nodes: [{ id: "01-plan", agent: "sp-planner", phase: "plan" }],
          },
        }),
      })
      const dispatched: string[] = []
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch(args) {
            const spec = JSON.parse(readFileSync(join(project, ".superpowers", "runs", state.id, "workflow-spec.json"), "utf8"))
            expect(spec.orchestration.nodes.some((node: { task_id?: string }) => node.task_id === args.decision.task_id)).toBe(true)
            dispatched.push(args.decision.task_id ?? args.decision.phase)
            return {
              action: args.decision.action,
              session_id: `session-${args.decision.task_id}`,
              task_markdown: "# Task",
            }
          },
        },
      })

      await handler({
        event: "plan",
        status: "passed",
        summary: "Planner expanded tasks.",
        artifacts: { plan: "# Plan" },
        gates: { plan_written: true },
        workflow_expansion: {
          reason: "Planner produced execution tasks.",
          tasks: [{ id: "T1", title: "Implement", summary: "Implement", depends_on: [], agent: "sp-implementer" }],
        },
      })

      expect(store.readCurrent()?.task_graph?.tasks.map((task) => task.id)).toEqual(["T1"])
      const workflowSpec = JSON.parse(readFileSync(join(project, ".superpowers", "runs", state.id, "workflow-spec.json"), "utf8"))
      expect(workflowSpec.orchestration.nodes.filter((node: { agent: string }) => node.agent === "sp-implementer").map((node: { task_id?: string }) => node.task_id).filter(Boolean)).toEqual(["T1"])
      expect(dispatched).toEqual(["T1"])
      expect(store.readCurrent()?.node_runs.at(-1)?.agent).toBe("sp-implementer")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("plan passed with runnable tasks dispatches implementer sessions and records node_runs", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-dispatch-"))
    try {
      const store = createProjectStore(project)
      const started = store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add gates",
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
          title: "Planned feature",
          autoExpansionAllow: true,
          orchestration: {
            nodes: [{ id: "01-plan", agent: "sp-planner", phase: "plan" }],
          },
        }),
      })

      const dispatched: string[] = []
      const progress: Array<{ stage: string; message: string }> = []
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch(args) {
            const spec = JSON.parse(readFileSync(join(project, ".superpowers", "runs", started.id, "workflow-spec.json"), "utf8"))
            expect(spec.orchestration.nodes.some((node: { task_id?: string }) => node.task_id === args.decision.task_id)).toBe(true)
            dispatched.push(args.packet.agent)
            return {
              action: args.decision.action,
              session_id: `session-${args.packet.task_id}`,
              task_markdown: `# Task\n\n${args.packet.objective}`,
            }
          },
        },
        progress: {
          async report(input) {
            progress.push({ stage: input.stage, message: input.message })
          },
        },
      })

      const output = await handler(
        {
          event: "plan",
          status: "passed",
          summary: "Plan ready.",
          artifacts: { plan: "# Plan" },
          gates: { plan_written: true },
          task_graph: {
            tasks: [
              { id: "T1", title: "Types", summary: "Add types", depends_on: [], files: ["src/types.ts"] },
              { id: "T2", title: "Store", summary: "Add store", depends_on: [], files: ["src/store.ts"] },
            ],
          },
        },
        { sessionID: "session-planner", agent: "sp-planner" },
      )

      const result = JSON.parse(output)
      const state = store.readCurrent()
      expect(dispatched).toEqual(["sp-implementer", "sp-implementer"])
      expect(result.dispatches).toHaveLength(2)
      expect(state?.node_runs.map((node) => node.task_id)).toEqual(["T1", "T2"])
      const workflowSpec = JSON.parse(readFileSync(join(project, ".superpowers", "runs", started.id, "workflow-spec.json"), "utf8"))
      expect(workflowSpec.orchestration.nodes.filter((node: { agent: string }) => node.agent === "sp-implementer").map((node: { task_id?: string }) => node.task_id).filter(Boolean)).toEqual(["T1", "T2"])
      expect(state?.node_runs.every((node) => node.status === "running")).toBe(true)
      expect(progress).toEqual([
        {
          stage: "node_recorded",
          message: "plan reported as passed; workflow is at plan-complete.",
        },
      ])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("plan passed returns after scheduling downstream child prompts that have not completed", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-dispatch-nonblocking-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add gates",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })

      let nextSession = 0
      const prompts: string[] = []
      const orchestrator = createSessionOrchestrator({
        async createNodeSession() {
          nextSession += 1
          return `session-impl-${nextSession}`
        },
        async continueNodeSession(input) {
          prompts.push(input.sessionID)
          return new Promise<void>(() => {})
        },
        async showProgress() {},
      })
      const handler = createReportHandler({
        store,
        orchestrator,
      })

      const output = await withTimeout(handler(
        {
          event: "plan",
          status: "passed",
          summary: "Plan ready.",
          artifacts: { plan: "# Plan" },
          gates: { plan_written: true },
          task_graph: {
            tasks: [
              { id: "T1", title: "Types", summary: "Add types", depends_on: [], files: ["src/types.ts"] },
            ],
          },
        },
        { sessionID: "session-planner", agent: "sp-planner" },
      ))

      const result = JSON.parse(output)
      const state = store.readCurrent()
      expect(result.dispatches).toEqual([
        {
          action: "create_session",
          agent: "sp-implementer",
          phase: "implement",
          task_id: "T1",
          session_id: "session-impl-1",
        },
      ])
      expect(state?.node_runs).toHaveLength(1)
      expect(state?.node_runs[0]).toMatchObject({
        phase: "implement",
        session_id: "session-impl-1",
        task_id: "T1",
        status: "running",
      })
      const workflowSpec = JSON.parse(readFileSync(join(project, ".superpowers", "runs", state?.id ?? "", "workflow-spec.json"), "utf8"))
      expect(workflowSpec.orchestration.nodes.filter((node: { agent: string }) => node.agent === "sp-implementer").map((node: { task_id?: string }) => node.task_id).filter(Boolean)).toEqual(["T1"])
      expect(prompts).toEqual(["session-impl-1"])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("needs_user records the pending question and does not dispatch", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-question-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add gates",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })

      const progress: Array<{ stage: string; message: string }> = []
      const notifications: Array<{ sessionID: string; agent: string; prompt: string }> = []
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch() {
            throw new Error("unexpected dispatch")
          },
          async notifyParent(input: { sessionID: string; agent: string; prompt: string }) {
            notifications.push(input)
          },
        } as never,
        progress: {
          async report(input) {
            progress.push({ stage: input.stage, message: input.message })
          },
        },
      })

      await handler(
        {
          event: "question",
          status: "needs_user",
          summary: "Need user input.",
          question: {
            prompt: "Use strict gates?",
            options: [
              { label: "yes", description: "Use strict gates." },
              { label: "no", description: "Keep the current gate policy." },
            ],
          },
        },
        { sessionID: "session-node", agent: "sp-designer" },
      )

      const state = store.readCurrent()
      expect(state?.status).toBe("waiting_user")
      expect(state?.pending_question?.prompt).toContain("strict")
      expect(state?.pending_question?.options).toEqual([
        { label: "yes", description: "Use strict gates." },
        { label: "no", description: "Keep the current gate policy." },
      ])
      expect(notifications).toHaveLength(1)
      expect(notifications[0].sessionID).toBe("session-main")
      expect(notifications[0].agent).toBe("superpowers-agent")
      expect(notifications[0].prompt).toContain("waiting for user input")
      expect(notifications[0].prompt).toContain("Use strict gates?")
      expect(notifications[0].prompt).toContain("sp_start")
      expect(notifications[0].prompt).toContain("resume_input")
      expect(progress).toEqual([
        {
          stage: "node_recorded",
          message: "question reported as needs_user; workflow is at waiting-user.",
        },
        {
          stage: "waiting_user_input",
          message: "Node requested user input.",
        },
      ])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("design approval prompt stays on the design child session", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-native-design-approval-"))
    try {
      const store = createProjectStore(project)
      store.prepareRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Design foreground flow",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
        prepareMode: "proposal_only",
      })
      const node = store.addNodeRun({
        phase: "design",
        agent: "sp-designer",
        primary_skill: "superpowers-brainstorming",
        session_id: "session-design",
        task_markdown: "# Design task",
      })
      const notifications: Array<{ sessionID: string; agent: string; prompt: string; selectSession?: boolean }> = []
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch() {
            throw new Error("unexpected dispatch")
          },
          async notifyParent(input: { sessionID: string; agent: string; prompt: string; selectSession?: boolean }) {
            notifications.push(input)
          },
        } as never,
        config: {
          ...DEFAULT_CONFIG,
          interaction: { mode: "native" },
        },
      })

      await handler(
        {
          event: "design",
          status: "passed",
          summary: "Design ready.",
          artifacts: { spec: "# Spec\n\nForeground confirmation." },
          gates: { design_approved: true, spec_written: true },
        },
        { sessionID: node.session_id, agent: "sp-designer" },
      )

      expect(store.readCurrent()?.status).toBe("awaiting_design_approval")
      expect(notifications).toHaveLength(1)
      expect(notifications[0].sessionID).toBe("session-design")
      expect(notifications[0].agent).toBe("sp-designer")
      expect(notifications[0].selectSession).toBe(true)
      expect(notifications[0].prompt).toContain("design candidate ready for review")
      expect(notifications[0].prompt).toContain("this design session")
      expect(notifications[0].prompt).not.toContain("approve_design")
      expect(notifications[0].prompt).not.toContain("main conversation")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("design needs_user prompt goes to the design child session", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-native-design-question-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Design with user choice",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      const node = store.addNodeRun({
        phase: "design",
        agent: "sp-designer",
        primary_skill: "superpowers-brainstorming",
        session_id: "session-design",
        task_markdown: "# Design task",
      })
      const notifications: Array<{ sessionID: string; agent: string; prompt: string; selectSession?: boolean }> = []
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch() {
            throw new Error("unexpected dispatch")
          },
          async notifyParent(input: { sessionID: string; agent: string; prompt: string; selectSession?: boolean }) {
            notifications.push(input)
          },
        } as never,
        config: {
          ...DEFAULT_CONFIG,
          interaction: { mode: "native" },
        },
      })

      await handler(
        {
          event: "design",
          status: "needs_user",
          summary: "Need design choice.",
          question: {
            prompt: "Should design include a review gate?",
            options: [{ label: "yes" }, { label: "no" }],
          },
        },
        { sessionID: node.session_id, agent: "sp-designer" },
      )

      expect(store.readCurrent()?.status).toBe("waiting_user")
      expect(notifications).toHaveLength(1)
      expect(notifications[0].sessionID).toBe("session-design")
      expect(notifications[0].agent).toBe("sp-designer")
      expect(notifications[0].selectSession).toBe(true)
      expect(notifications[0].prompt).toContain("this design session")
      expect(notifications[0].prompt).toContain("Should design include a review gate?")
      expect(notifications[0].prompt).not.toContain("resume_input")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("native plan approval prompt goes to the parent controller session", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-native-plan-approval-"))
    try {
      const store = createProjectStore(project)
      store.prepareRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Plan foreground flow",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
        prepareMode: "proposal_only",
      })
      const node = store.addNodeRun({
        phase: "plan",
        agent: "sp-planner",
        primary_skill: "superpowers-writing-plans",
        session_id: "session-plan",
        task_markdown: "# Plan task",
      })
      const notifications: Array<{ sessionID: string; agent: string; prompt: string; selectSession?: boolean }> = []
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch() {
            throw new Error("unexpected dispatch")
          },
          async notifyParent(input: { sessionID: string; agent: string; prompt: string; selectSession?: boolean }) {
            notifications.push(input)
          },
        } as never,
        config: {
          ...DEFAULT_CONFIG,
          interaction: { mode: "native" },
        },
      })

      await handler(
        {
          event: "plan",
          status: "passed",
          summary: "Plan ready.",
          artifacts: { plan: "# Plan\n\nImplement T1." },
          gates: { plan_written: true },
          task_graph: {
            tasks: [{ id: "T1", title: "Implement T1", summary: "Implement foreground flow.", depends_on: [] }],
          },
        },
        { sessionID: node.session_id, agent: "sp-planner" },
      )

      expect(store.readCurrent()?.status).toBe("awaiting_plan_approval")
      expect(notifications).toHaveLength(1)
      expect(notifications[0].sessionID).toBe("session-main")
      expect(notifications[0].agent).toBe("superpowers-agent")
      expect(notifications[0].selectSession).toBe(true)
      expect(notifications[0].prompt).toContain("plan waiting for approval")
      expect(notifications[0].prompt).toContain("main conversation")
      expect(notifications[0].prompt).toContain('"start_action": "resolve_controller_decision"')
      expect(notifications[0].prompt).not.toContain("approve_plan")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("progress report updates the running node without downstream dispatch", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-progress-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add gates",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      const node = store.addNodeRun({
        phase: "plan",
        agent: "sp-planner",
        primary_skill: "superpowers-writing-plans",
        session_id: "session-planner",
        task_markdown: "# Plan task",
      })

      const progress: Array<{ stage: string; message: string }> = []
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch() {
            throw new Error("progress reports must not dispatch")
          },
        },
        progress: {
          async report(input) {
            progress.push({ stage: input.stage, message: input.message })
          },
        },
      })

      const output = await handler(
        {
          event: "plan",
          status: "progress",
          summary: "Drafting the task graph.",
          artifacts: { plan: "# Draft plan" },
        },
        { sessionID: "session-planner", agent: "sp-planner" },
      )

      const result = JSON.parse(output)
      const state = store.readCurrent()
      expect(result.dispatches).toEqual([])
      expect(result.decisions).toEqual([])
      expect(state?.node_runs.find((run) => run.id === node.id)).toMatchObject({
        status: "running",
        record_path: `nodes/${node.id}/record.json`,
      })
      expect(state?.artifacts.plan).toBe("plan.md")
      expect(progress).toEqual([
        {
          stage: "node_recorded",
          message: "plan reported as progress; workflow is at plan-retry.",
        },
      ])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("implementation report dispatches task-scoped acceptance with task and report context", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-acceptance-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add gates",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      store.record({
        event: "plan",
        status: "passed",
        summary: "Plan ready.",
        artifacts: { plan: "# Plan" },
        gates: { plan_written: true },
        task_graph: {
          tasks: [
            {
              id: "T1",
              title: "Types",
              summary: "Add workflow state types.",
              depends_on: [],
              files: ["src/state/types.ts"],
              test_commands: ["bun test test/state.test.ts"],
            },
            {
              id: "T2",
              title: "Store",
              summary: "Persist workflow state.",
              depends_on: ["T1"],
              files: ["src/state/store.ts"],
            },
          ],
        },
      })
      store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-impl",
        task_id: "T1",
        task_markdown: "# Task\n\nImplement T1.",
      })

      const prompts: string[] = []
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch(args) {
            const taskMarkdown = buildNodeTaskPrompt(args.packet)
            prompts.push(taskMarkdown)
            return {
              action: args.decision.action,
              session_id: "session-acceptance",
              task_markdown: taskMarkdown,
            }
          },
        },
      })

      const output = await handler(
        {
          event: "implementation",
          status: "passed",
          summary: "Implemented workflow state types.",
          artifacts: { patch_summary: "Changed src/state/types.ts and added type coverage." },
          gates: { implementation_done: true },
        },
        { sessionID: "session-impl", agent: "sp-implementer" },
      )

      const result = JSON.parse(output)
      const acceptance = result.dispatches[0]
      expect(acceptance).toMatchObject({
        agent: "sp-acceptance-reviewer",
        phase: "acceptance",
        task_id: "T1",
        session_id: "session-acceptance",
      })
      expect(prompts[0]).toContain("## Task Scope")
      expect(prompts[0]).toContain("Task ID: T1")
      expect(prompts[0]).toContain("Title: Types")
      expect(prompts[0]).toContain("Add workflow state types.")
      expect(prompts[0]).toContain("src/state/types.ts")
      expect(prompts[0]).toContain("bun test test/state.test.ts")
      expect(prompts[0]).toContain("## Implementation Completion Summary")
      expect(prompts[0]).toContain("Implemented workflow state types.")
      expect(prompts[0]).toContain("Changed src/state/types.ts and added type coverage.")
      expect(prompts[0]).toContain("Do not fail this task because other task graph items are not implemented yet.")
      expect(prompts[0]).toContain("reports/T1/report.md")
      expect(store.readCurrent()?.node_runs.at(-1)?.task_id).toBe("T1")
      expect(store.readCurrent()?.node_runs.at(-1)?.phase).toBe("acceptance")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("parallel implementation report completes the node matching the reporting session", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-parallel-session-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add parallel tasks",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      store.record({
        event: "plan",
        status: "passed",
        summary: "Plan ready.",
        artifacts: { plan: "# Plan" },
        gates: { plan_written: true },
        task_graph: {
          tasks: [
            { id: "T1", title: "Types", summary: "Add types", depends_on: [] },
            { id: "T2", title: "Store", summary: "Add store", depends_on: [] },
          ],
        },
      })
      const task1 = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-impl-T1",
        task_id: "T1",
        task_markdown: "# Task\n\nImplement T1.",
      })
      const task2 = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-impl-T2",
        task_id: "T2",
        task_markdown: "# Task\n\nImplement T2.",
      })

      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch(args) {
            return {
              action: args.decision.action,
              session_id: "session-acceptance-T1",
              task_markdown: buildNodeTaskPrompt(args.packet),
            }
          },
        },
      })

      const output = await handler(
        {
          event: "implementation",
          status: "passed",
          summary: "Implemented T1.",
          artifacts: { patch_summary: "Patch for T1." },
          gates: { implementation_done: true },
        },
        { sessionID: "session-impl-T1", agent: "sp-implementer" },
      )

      const result = JSON.parse(output)
      const state = store.readCurrent()
      expect(state?.node_runs.find((run) => run.id === task1.id)).toMatchObject({
        task_id: "T1",
        status: "passed",
      })
      expect(state?.node_runs.find((run) => run.id === task2.id)).toMatchObject({
        task_id: "T2",
        status: "running",
      })
      expect(result.dispatches[0]).toMatchObject({
        agent: "sp-acceptance-reviewer",
        phase: "acceptance",
        task_id: "T1",
      })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("failed check dispatches retry implementer and restores workflow to running", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-retry-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add gates",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      const implementer = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-impl",
        task_id: "T1",
        task_markdown: "# Task\n\nImplement T1.",
      })
      store.recordNodeResult({
        nodeID: implementer.id,
        input: {
          event: "implementation",
          status: "passed",
          summary: "Implemented T1.",
          artifacts: { patch_summary: "Patch summary." },
          gates: { implementation_done: true },
        },
      })
      store.addNodeRun({
        phase: "acceptance",
        agent: "sp-acceptance-reviewer",
        primary_skill: "superpowers-requesting-code-review",
        session_id: "session-acceptance",
        task_id: "T1",
        task_markdown: "# Acceptance\n\nReview T1.",
      })

      const prompts: string[] = []
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch(args) {
            const taskMarkdown = buildNodeTaskPrompt(args.packet)
            prompts.push(taskMarkdown)
            return {
              action: args.decision.action,
              session_id: args.decision.action === "reuse_session" ? args.decision.session_id : "session-new",
              task_markdown: taskMarkdown,
            }
          },
        },
      })

      const output = await handler(
        {
          event: "acceptance",
          status: "failed",
          summary: "Acceptance found a missing edge case.",
          findings: "Missing validation for empty input.",
        },
        { sessionID: "session-acceptance", agent: "sp-acceptance-reviewer" },
      )

      const result = JSON.parse(output)
      const state = store.readCurrent()
      expect(result.dispatches[0]).toMatchObject({
        action: "reuse_session",
        agent: "sp-implementer",
        phase: "implement",
        task_id: "T1",
        session_id: "session-impl",
      })
      expect(state?.status).toBe("running")
      expect(state?.current_phase).toBe("implement")
      expect(state?.node_runs.at(-1)).toMatchObject({
        phase: "implement",
        agent: "sp-implementer",
        task_id: "T1",
        status: "running",
        attempts: 2,
      })
      expect(prompts[0]).toContain("## Retry Context")
      expect(prompts[0]).toContain("Acceptance found a missing edge case.")
      expect(prompts[0]).toContain("Missing validation for empty input.")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
