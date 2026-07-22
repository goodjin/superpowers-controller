import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bridgeChildAnswerToPendingQuestion,
  matchSelectedOptions,
} from "../src/runtime/child-answer-bridge"
import { createProjectStore } from "../src/state/store"
import { createReportHandler } from "../src/tools/report-handler"

describe("child answer bridge", () => {
  test("matchSelectedOptions maps A/B letters to option labels", () => {
    const options = [
      { label: "沿用 plan 的最小内联错误（推荐）" },
      { label: "每字段 Form 校验" },
    ]
    expect(matchSelectedOptions("A", options)).toEqual([options[0]!.label])
    expect(matchSelectedOptions("B.", options)).toEqual([options[1]!.label])
    expect(matchSelectedOptions("2", options)).toEqual([options[1]!.label])
  })

  test("bridges a child chat reply into consumePendingQuestion", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-child-bridge-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "UI",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-parent",
      })
      store.addNodeRun({
        phase: "design",
        agent: "sp-designer",
        session_id: "session-child",
        task_markdown: "# Task",
      })
      store.recordNodeResult({
        sessionID: "session-child",
        agent: "sp-designer",
        input: {
          event: "design",
          status: "needs_user",
          summary: "Ask Q3",
          question: {
            prompt: "Pick validation style",
            options: [
              { label: "A. inline" },
              { label: "B. form" },
            ],
          },
        },
      })

      expect(store.readCurrent()?.status).toBe("waiting_user")

      const result = bridgeChildAnswerToPendingQuestion({
        store,
        sessionID: "session-child",
        parts: [{ type: "text", text: "A" }],
      })

      expect(result.bridged).toBe(true)
      if (!result.bridged) throw new Error("expected bridge")
      expect(result.kind).toBe("needs_user")
      if (result.kind !== "needs_user") throw new Error("expected needs_user")
      expect(result.selected_options).toEqual(["A. inline"])

      const state = store.readCurrent()!
      expect(state.status).toBe("running")
      expect(state.pending_question).toBeUndefined()
      expect(state.node_runs[0]?.status).toBe("running")
      expect(state.history.some((entry) => entry.event === "user_input_resumed")).toBe(true)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("ignores answers typed in the parent while still waiting_user", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-child-bridge-parent-"))
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "UI",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-parent",
      })
      store.addNodeRun({
        phase: "design",
        agent: "sp-designer",
        session_id: "session-child",
        task_markdown: "# Task",
      })
      store.recordNodeResult({
        sessionID: "session-child",
        agent: "sp-designer",
        input: {
          event: "design",
          status: "needs_user",
          summary: "Ask Q3",
          question: { prompt: "Pick one", options: [{ label: "A" }, { label: "B" }] },
        },
      })

      const result = bridgeChildAnswerToPendingQuestion({
        store,
        sessionID: "session-parent",
        parts: [{ type: "text", text: "A" }],
      })
      expect(result.bridged).toBe(false)
      expect(store.readCurrent()?.status).toBe("waiting_user")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("hands design approval from the design child back to the parent", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-child-bridge-design-approval-"))
    try {
      const store = createProjectStore(project)
      store.prepareRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Design approval",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-parent",
        prepareMode: "managed_design",
      })
      store.addNodeRun({
        phase: "design",
        agent: "sp-designer",
        session_id: "session-design",
        task_markdown: "# Task",
      })
      store.recordNodeResult({
        sessionID: "session-design",
        agent: "sp-designer",
        input: {
          event: "design",
          status: "passed",
          summary: "Candidate ready",
          artifacts: { spec: "# Spec" },
          gates: { spec_written: true },
        },
      })
      expect(store.readCurrent()?.status).toBe("awaiting_design_approval")

      const result = bridgeChildAnswerToPendingQuestion({
        store,
        sessionID: "session-design",
        parts: [{ type: "text", text: "同意" }],
      })
      expect(result.bridged).toBe(true)
      if (!result.bridged || result.kind !== "design_approval_handoff") {
        throw new Error("expected design_approval_handoff")
      }
      expect(result.parent_session_id).toBe("session-parent")
      expect(result.prompt).toContain("already approved")
      expect(store.readCurrent()?.status).toBe("awaiting_design_approval")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

describe("late report notify short-circuit", () => {
  test("ignored late needs_user report does not notify parent again", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-late-ignore-notify-"))
    const notifications: string[] = []
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "UI",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-parent",
      })
      store.addNodeRun({
        phase: "design",
        agent: "sp-designer",
        session_id: "session-child",
        task_markdown: "# Task",
      })
      store.recordNodeResult({
        sessionID: "session-child",
        agent: "sp-designer",
        input: {
          event: "design",
          status: "needs_user",
          summary: "Ask Q3",
          question: {
            prompt: "Q3",
            options: [{ label: "A" }, { label: "B" }],
          },
        },
      })

      const handler = createReportHandler({
        store,
        orchestrator: {
          async dispatch() {
            return { action: "create_session" as const, session_id: "x", task_markdown: "#" }
          },
          async notifyParent(input) {
            notifications.push(input.prompt)
          },
        },
      })

      const raw = await handler(
        {
          event: "design",
          status: "needs_user",
          summary: "Ask Q4 after answering in child",
          question: { prompt: "Q4", options: [{ label: "A" }] },
        },
        { sessionID: "session-child", agent: "sp-designer" },
      )
      const parsed = JSON.parse(raw) as { late_report_ignored?: boolean }
      expect(parsed.late_report_ignored).toBe(true)
      expect(notifications).toHaveLength(0)
      expect(store.readCurrent()?.pending_question?.prompt).toBe("Q3")
      expect(store.lastRecordOutcome()?.lateIgnored).toBe(true)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
