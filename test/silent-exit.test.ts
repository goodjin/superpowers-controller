import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  collectSilentExitEvidence,
  extractLastAssistantText,
} from "../src/runtime/silent-exit"
import { createUnreportedExitHandler } from "../src/runtime/unreported-exit-handler"
import { createProjectStore } from "../src/state/store"

describe("silent exit evidence", () => {
  test("extractLastAssistantText skips controller prompts and returns last design text", () => {
    const text = extractLastAssistantText([
      {
        role: "assistant",
        parts: [{ type: "text", text: "# Superpowers User Input Resume\ncontinue" }],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "# Candidate Design\n\nShip light theme only." }],
      },
    ])
    expect(text).toContain("Candidate Design")
    expect(text).toContain("light theme")
  })

  test("collectSilentExitEvidence gathers assistant text and tool produced paths", () => {
    const evidence = collectSilentExitEvidence({
      reason: "session_idle",
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "tool",
              tool: "write",
              state: {
                status: "completed",
                input: { filePath: "docs/superpowers/specs/ui.md" },
              },
            },
            {
              type: "text",
              text: "Wrote the candidate spec and stopped.",
            },
          ],
        },
      ],
      progress: [{
        at: "2026-07-14T00:00:00.000Z",
        kind: "patch",
        session_id: "s1",
        node_id: "001-design",
        agent: "sp-designer",
        phase: "design",
        summary: "patch updated: 1 file",
        detail: "/Users/jin/vpn/docs/superpowers/specs/ui.md",
      }],
    })

    expect(evidence.assistant_text).toContain("candidate spec")
    expect(evidence.produced_paths).toContain("docs/superpowers/specs/ui.md")
    expect(evidence.produced_paths).toContain("/Users/jin/vpn/docs/superpowers/specs/ui.md")
    expect(evidence.summary).toContain("without sp_report")
  })
})

describe("unreported exit handler", () => {
  test("session idle without sp_report stores evidence and notifies parent", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-silent-exit-"))
    const prompts: Array<{ sessionID: string; prompt: string; selectSession?: boolean }> = []
    const focused: Array<{ sessionID: string; message?: string }> = []
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

      const handler = createUnreportedExitHandler({
        store,
        orchestrator: {
          async notifyParent(input) {
            prompts.push({
              sessionID: input.sessionID,
              prompt: input.prompt,
              selectSession: input.selectSession,
            })
          },
          async returnToParent(input) {
            focused.push(input)
          },
        },
        progress: { async report() {} },
        async fetchMessages() {
          return [{
            role: "assistant",
            parts: [
              {
                type: "tool",
                tool: "edit",
                state: {
                  status: "completed",
                  input: { path: "app/lib/app.dart" },
                },
              },
              { type: "text", text: "Here is the candidate UI design for Phase 7." },
            ],
          }]
        },
        readProgressForNode: () => [],
      })

      const result = await handler.handle({
        sessionID: "session-child",
        reason: "session_idle",
      })
      expect(result.handled).toBe(true)

      const state = store.readCurrent()!
      expect(state.status).toBe("waiting_controller_decision")
      expect(state.node_runs[0]?.status).toBe("interrupted")
      expect(state.current_phase).toBe("unreported-idle")

      const jsonPath = join(store.root, "runs", state.id, "nodes", state.node_runs[0]!.id, "silent-exit.json")
      const mdPath = join(store.root, "runs", state.id, "nodes", state.node_runs[0]!.id, "silent-exit.md")
      expect(existsSync(jsonPath)).toBe(true)
      expect(existsSync(mdPath)).toBe(true)
      const body = JSON.parse(readFileSync(jsonPath, "utf8"))
      expect(body.assistant_text).toContain("candidate UI design")
      expect(body.produced_paths).toContain("app/lib/app.dart")

      expect(focused).toEqual([{
        sessionID: "session-parent",
        message: "子会话异常结束，已切回主控。",
      }])
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.sessionID).toBe("session-parent")
      expect(prompts[0]?.selectSession).toBe(false)
      expect(prompts[0]?.prompt).toContain("without calling `sp_report`")
      expect(prompts[0]?.prompt).toContain("app/lib/app.dart")
      expect(prompts[0]?.prompt).toContain("candidate UI design")

      const again = await handler.handle({
        sessionID: "session-child",
        reason: "session_idle",
      })
      expect(again.handled).toBe(false)
      expect(prompts).toHaveLength(1)
      expect(focused).toHaveLength(1)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("silent exit with running sibling still returns to parent and notifies", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-silent-exit-sibling-"))
    const prompts: Array<{ sessionID: string; prompt: string }> = []
    const focused: Array<{ sessionID: string; message?: string }> = []
    try {
      const store = createProjectStore(project)
      store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Parallel",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-parent",
      })
      store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-t1",
        task_id: "T1",
        task_markdown: "# T1",
      })
      store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-t4",
        task_id: "T4",
        task_markdown: "# T4",
      })

      const handler = createUnreportedExitHandler({
        store,
        orchestrator: {
          async notifyParent(input) {
            prompts.push({ sessionID: input.sessionID, prompt: input.prompt })
          },
          async returnToParent(input) {
            focused.push(input)
          },
        },
        progress: { async report() {} },
        async fetchMessages() {
          return [{
            role: "assistant",
            parts: [{ type: "text", text: "Stopped mid-task without report." }],
          }]
        },
        readProgressForNode: () => [],
      })

      const result = await handler.handle({
        sessionID: "session-t4",
        reason: "session_idle",
      })
      expect(result.handled).toBe(true)

      const state = store.readCurrent()!
      expect(state.status).toBe("running")
      expect(state.node_runs.find((n) => n.session_id === "session-t4")?.status).toBe("interrupted")
      expect(state.node_runs.find((n) => n.session_id === "session-t1")?.status).toBe("running")

      expect(focused).toEqual([{
        sessionID: "session-parent",
        message: "子会话异常结束，已切回主控。其它任务仍在跑。",
      }])
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.prompt).toContain("sibling nodes are still marked running")
      expect(prompts[0]?.prompt).toContain("Stopped mid-task")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("needs_user idle is ignored because node is not running", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-silent-exit-needs-user-"))
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
          summary: "Ask Q1",
          question: { prompt: "Pick a theme", options: [{ label: "light" }] },
        },
      })

      let notified = 0
      const handler = createUnreportedExitHandler({
        store,
        orchestrator: {
          async notifyParent() {
            notified += 1
          },
        },
        progress: { async report() {} },
        async fetchMessages() {
          return []
        },
        readProgressForNode: () => [],
      })

      const result = await handler.handle({
        sessionID: "session-child",
        reason: "session_idle",
      })
      expect(result.handled).toBe(false)
      expect(notified).toBe(0)
      expect(store.readCurrent()?.status).toBe("waiting_user")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
