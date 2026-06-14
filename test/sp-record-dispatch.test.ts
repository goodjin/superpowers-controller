import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProjectStore } from "../src/state/store"
import { createRecordHandler } from "../src/tools/sp-record"

describe("sp_record dispatch integration", () => {
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
      const handler = createRecordHandler({
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

      const handler = createRecordHandler({
        store,
        orchestrator: {
          async dispatch() {
            throw new Error("unexpected dispatch")
          },
        },
      })

      await handler(
        {
          event: "question",
          status: "needs_user",
          summary: "Need user input.",
          question: { prompt: "Use strict gates?", options: ["yes", "no"] },
        },
        { sessionID: "session-node", agent: "sp-designer" },
      )

      const state = store.readCurrent()
      expect(state?.status).toBe("waiting_user")
      expect(state?.pending_question?.prompt).toContain("strict")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
