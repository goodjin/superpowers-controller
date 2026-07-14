import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createNodeProgressStore } from "../src/progress/node-progress"
import { createProjectStore } from "../src/state/store"
import { createTools } from "../src/tools"
import { createCancelTool } from "../src/tools/sp-cancel"
import { createReportTool } from "../src/tools/sp-report"
import { createStatusTool } from "../src/tools/sp-status"

describe("public Superpowers tools", () => {
  test("exposes the simplified workflow tool set", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-tools-registry-"))
    try {
      const store = createProjectStore(project)
      expect(Object.keys(createTools(store)).sort()).toEqual([
        "sp_cancel",
        "sp_prepare",
        "sp_report",
        "sp_start",
        "sp_status",
      ])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

describe("sp_status tool", () => {
  test("returns v5 capabilities when requested", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-status-capabilities-"))
    try {
      const store = createProjectStore(project)
      const status = createStatusTool(store)

      const output = await status.execute(
        {
          include_capabilities: true,
        },
        {
          sessionID: "session-main",
          messageID: "message-1",
          agent: "superpowers-agent",
          directory: project,
          worktree: project,
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      )

      const result = JSON.parse(toolOutput(output))
      expect(result.capabilities.agent_catalog.map((item: { agent: string }) => item.agent)).toContain("sp-planner")
      expect(result.capabilities.workflow_schema.built_in_workflow_ids).toContain("single-agent")
      expect(result.capabilities.built_in_workflow_templates.map((item: { id: string }) => item.id)).toContain("bugfix")
      expect(result.capabilities.workflow_examples.length).toBeGreaterThan(0)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("returns the current workflow and can focus a task", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-status-tool-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add workflow gates",
        request: "# Request",
        proposal: "# Proposal",
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
      const status = createStatusTool(store)

      const output = await status.execute(
        {
          task_id: "T1",
        },
        {
          sessionID: "session-1",
          messageID: "message-1",
          agent: "superpowers-agent",
          directory: project,
          worktree: project,
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      )

      const result = JSON.parse(toolOutput(output))
      expect(result.source).toBe("runtime_memory")
      expect(result.current.task_graph.tasks[0].id).toBe("T1")
      expect(result.task.task.id).toBe("T1")
      expect(result.runtime.status_authority).toBe("runtime_memory")
      expect(result.node_summary).toMatchObject({
        total: 0,
        counts: {},
        unfinished_nodes: [],
        task_completion: {
          total: 1,
          passed: 0,
          unfinished: 0,
          pending: 1,
        },
      })
      expect(result.node_summary.last_node).toBeUndefined()
      expect(result.node_summary.detail_hint).toContain('detail="sessions"')
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("returns session detail with progress while marking live status unavailable from tool context", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-status-sessions-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Add workflow gates",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      const node = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-child",
        task_id: "T1",
        task_markdown: "Implement T1",
      })
      createNodeProgressStore(project).append(state.id, {
        at: new Date().toISOString(),
        kind: "tool_running",
        session_id: "session-child",
        node_id: node.id,
        agent: "sp-implementer",
        phase: "implement",
        task_id: "T1",
        summary: "bash running",
        detail: "bun test",
      })
      const status = createStatusTool(store)

      const output = await status.execute(
        {
          detail: "sessions",
          include_progress: true,
          progress_tail: 1,
          session_id: "session-child",
        },
        {
          sessionID: "session-main",
          messageID: "message-1",
          agent: "superpowers-agent",
          directory: project,
          worktree: project,
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      )

      const result = JSON.parse(toolOutput(output))
      expect(result.source).toBe("runtime_memory")
      expect(result.summary.sessions.running).toBe(1)
      expect(result.node_summary).toMatchObject({
        total: 1,
        counts: { running: 1 },
        last_node: {
          node_id: node.id,
          task_id: "T1",
          status: "running",
          activity_status: "active",
          latest_progress: {
            kind: "tool_running",
            summary: "bash running",
          },
        },
        unfinished_nodes: [
          {
            node_id: node.id,
            status: "running",
          },
        ],
        running_nodes: [
          {
            node_id: node.id,
            status: "running",
          },
        ],
      })
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0]).toMatchObject({
        node_id: node.id,
        session_id: "session-child",
        durable_status: "running",
        latest_progress: {
          kind: "tool_running",
          summary: "bash running",
        },
        live: {
          status: "unknown",
          source: "unavailable_in_tool_context",
        },
      })
      expect(result.sessions[0].progress_tail).toHaveLength(1)
      expect(result.durable.role).toBe("snapshot")
      expect(result.recommended_next.action).toBe("wait_running_node")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("returns allowed controller decisions for a dispatch failure", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-status-controller-decisions-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Retry failed dispatch",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      const failed = store.markDispatchFailed({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        task_id: "T1",
        error: new Error("child session unavailable"),
      })
      const status = createStatusTool(store)

      const output = await status.execute(
        {},
        {
          sessionID: "session-main",
          messageID: "message-1",
          agent: "superpowers-agent",
          directory: project,
          worktree: project,
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      )

      const result = JSON.parse(toolOutput(output))
      expect(result.allowed_controller_decisions.map((decision: { kind: string }) => decision.kind)).toContain("retry_node")
      expect(result.controller_feedback.allowed_controller_decisions[0]).toMatchObject({
        kind: "retry_node",
        tool: "sp_start",
        payload: {
          run_id: result.current.id,
          start_action: "resolve_controller_decision",
          controller_decision: {
            kind: "retry_node",
            node_id: failed.id,
            task_id: "T1",
          },
        },
      })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("returns an on-demand progress digest for main-session tool results", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-status-progress-digest-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Show child progress in the main session",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      const node = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-child",
        task_id: "T2",
        task_markdown: "Implement T2",
      })
      const progress = createNodeProgressStore(project)
      const now = Date.now()
      progress.append(state.id, {
        at: new Date(now - 1_000).toISOString(),
        kind: "tool_running",
        session_id: "session-child",
        node_id: node.id,
        agent: "sp-implementer",
        phase: "implement",
        task_id: "T2",
        summary: "bash running",
        detail: "bun test test/tools.test.ts",
      })
      progress.append(state.id, {
        at: new Date(now).toISOString(),
        kind: "text",
        session_id: "session-child",
        node_id: node.id,
        agent: "sp-implementer",
        phase: "implement",
        task_id: "T2",
        summary: "assistant text updated",
        detail: "Investigating failing assertion.",
      })
      const status = createStatusTool(store)

      const output = await status.execute(
        {
          include_progress: true,
          progress_tail: 2,
        },
        {
          sessionID: "session-main",
          messageID: "message-1",
          agent: "superpowers-agent",
          directory: project,
          worktree: project,
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      )

      const result = JSON.parse(toolOutput(output))
      expect(result.progress_digest).toMatchObject({
        delivery: "on_demand_tool_result",
        display_policy: "main_session_summary",
        workflow: "feature",
        status: "running",
        phase: "implement",
        recommended_next: "wait_running_node",
        current_activity: {
          node_id: node.id,
          session_id: "session-child",
          agent: "sp-implementer",
          task_id: "T2",
          kind: "text",
          summary: "assistant text updated",
          detail: "Investigating failing assertion.",
        },
      })
      expect(result.progress_digest.recent_activity).toHaveLength(2)
      expect(result.progress_digest.recent_activity[0]).toMatchObject({
        kind: "tool_running",
        summary: "bash running",
      })
      expect(result.progress_digest.note).toContain("on demand")
      expect(result.node_summary.unfinished_nodes).toEqual([
        expect.objectContaining({
          node_id: node.id,
          task_id: "T2",
          status: "running",
        }),
      ])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("does not recommend retrying an interrupted attempt after a newer retry exists", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-status-interrupted-retry-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Retry task",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-old",
        task_id: "T3",
        task_markdown: "Implement T3",
      })
      store.recoverInterruptedRunningNodes({ reason: "test restart" })
      const retry = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-new",
        task_id: "T3",
        task_markdown: "Retry T3",
      })
      const status = createStatusTool(store)

      const output = await status.execute(
        {
          detail: "sessions",
          session_id: "session-new",
        },
        {
          sessionID: "session-main",
          messageID: "message-1",
          agent: "superpowers-agent",
          directory: project,
          worktree: project,
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      )

      const result = JSON.parse(toolOutput(output))
      expect(result.recommended_next).toMatchObject({
        action: "wait_running_node",
        node_id: retry.id,
      })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("reports startup-recovered workflow-level running state without live running sessions", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-status-recovered-workflow-running-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Resume after restart",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      const node = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-impl",
        task_id: "T1",
        task_markdown: "Implement T1",
      })
      store.recordNodeResult({
        nodeID: node.id,
        input: {
          event: "implementation",
          status: "passed",
          summary: "Implementation passed.",
          artifacts: { patch_summary: "Done." },
          gates: { implementation_done: true },
        },
      })
      const restartedStore = createProjectStore(project, { reconcileOnLoad: true })
      const status = createStatusTool(restartedStore)

      const output = await status.execute(
        {
          detail: "sessions",
        },
        {
          sessionID: "session-main",
          messageID: "message-1",
          agent: "superpowers-agent",
          directory: project,
          worktree: project,
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      )

      const result = JSON.parse(toolOutput(output))
      expect(result.source).toBe("runtime_memory")
      expect(result.summary.status).toBe("recovered_unknown")
      expect(result.summary.sessions.running).toBe(0)
      expect(result.sessions.every((session: { durable_status: string }) => session.durable_status !== "running")).toBe(true)
      expect(result.recommended_next).toMatchObject({
        action: "resume_or_cancel_recovered_workflow",
        reason: expect.stringContaining('sp_start(run_id, resume="all")'),
      })
      expect(result.allowed_controller_decisions.map((decision: { kind: string }) => decision.kind)).toEqual([
        "mark_blocked",
        "request_reprepare",
      ])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

describe("sp_report tool", () => {
  test("rejects control-plane fields from model output", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-report-tool-"))
    try {
      const store = createProjectStore(project)
      store.start({ session: "session-1", mode: "verify-finish", goal: "verify work" })
      const report = createReportTool(store, {
        async dispatch() {
          throw new Error("unexpected dispatch")
        },
      })

      await expect(
        report.execute(
          {
            event: "verification",
            status: "failed",
            summary: "Tests failed.",
            next_action: "retry",
          },
          {
            sessionID: "session-1",
            messageID: "message-1",
            agent: "sp-verifier",
            directory: project,
            worktree: project,
            abort: new AbortController().signal,
            metadata() {},
            async ask() {},
          },
        ),
      ).rejects.toThrow()
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

describe("sp_cancel tool", () => {
  test("cancels the current workflow and preserves it for status/history queries", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-cancel-tool-"))
    try {
      const store = createProjectStore(project)
      const state = store.prepareRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add workflow gates",
        request: "# Request\n\nAdd workflow gates.",
        proposal: "# Proposal\n\nPrepare feature workflow.",
        parentSessionID: "session-main",
      })

      const cancel = createCancelTool(store)
      const output = await cancel.execute(
        {
          workflow_id: state.id,
          reason: "User chose to stop.",
        },
        {
          sessionID: "session-main",
          messageID: "message-1",
          agent: "superpowers-agent",
          directory: project,
          worktree: project,
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      )
      const result = JSON.parse(typeof output === "string" ? output : String(output))
      expect(result.state.status).toBe("canceled")
      expect(store.readRun(state.id)?.history.at(-1)?.event).toBe("workflow_canceled")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

function toolOutput(value: unknown): string {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && "output" in value) return String((value as { output: unknown }).output)
  return String(value)
}
