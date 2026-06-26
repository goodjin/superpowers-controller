import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildNodeTaskPrompt } from "../src/session/templates"
import { createProjectStore } from "../src/state/store"
import { createReportHandler } from "../src/tools/report-handler"

describe("sp_report dispatch integration", () => {
  test("plan passed with runnable tasks dispatches implementer sessions and records node_runs", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-record-dispatch-"))
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

      const dispatched: string[] = []
      const progress: Array<{ stage: string; message: string }> = []
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch(args) {
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
      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch() {
            throw new Error("unexpected dispatch")
          },
        },
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
