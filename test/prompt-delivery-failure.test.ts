import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAllowedControllerDecisions, buildControllerFeedback } from "../src/controller/feedback"
import { createReportHandler } from "../src/tools/report-handler"
import { createProjectStore } from "../src/state/store"

describe("prompt delivery failure handling", () => {
  const projects: string[] = []

  afterEach(() => {
    for (const project of projects.splice(0)) {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("markPromptDeliveryFailed closes the running node and keeps workflow running when siblings exist", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-prompt-failure-"))
    projects.push(project)
    const store = createProjectStore(project)
    store.startRun({
      workflow: "feature",
      entrypoint: "feature",
      goal: "Parallel tasks",
      request: "# Request",
      proposal: "# Proposal",
      parentSessionID: "session-main",
    })
    store.addNodeRun({
      phase: "implement",
      agent: "sp-implementer",
      session_id: "session-T1",
      task_id: "T1",
      task_markdown: "# Task T1",
    })
    store.addNodeRun({
      phase: "implement",
      agent: "sp-implementer",
      session_id: "session-T2",
      task_id: "T2",
      task_markdown: "# Task T2",
    })

    const updated = store.markPromptDeliveryFailed({
      session_id: "session-T1",
      error: new Error("continueNodeSession failed"),
    })

    const state = store.readCurrent()
    expect(updated?.status).toBe("dispatch_failed")
    expect(state?.status).toBe("running")
    expect(state?.node_runs.find((run) => run.session_id === "session-T2")?.status).toBe("running")

    const feedback = buildControllerFeedback(state!)
    expect(feedback.parallel_context?.failed_nodes).toHaveLength(1)
    expect(feedback.parallel_context?.running_nodes).toHaveLength(1)
    expect(buildAllowedControllerDecisions(state!).some((item) => item.kind === "retry_node")).toBe(true)
    expect(buildAllowedControllerDecisions(state!).some((item) => item.kind === "continue_existing_graph")).toBe(true)
  })

  test("report handler records prompt delivery failure via orchestrator callback", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-prompt-failure-handler-"))
    projects.push(project)
    const store = createProjectStore(project)
    store.startRun({
      workflow: "feature",
      entrypoint: "feature",
      goal: "Single task",
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
        tasks: [{ id: "T1", title: "T1", summary: "T1", depends_on: [] }],
      },
    })

    const handler = createReportHandler({
      store,
      orchestrator: {
        async dispatch(args) {
          await args.onSessionCreated?.({
            sessionID: "session-impl",
            taskMarkdown: "# Task",
          })
          await args.onPromptDeliveryFailed?.({
            sessionID: "session-impl",
            agent: args.decision.agent,
            nodeID: args.packet.node_id,
            error: new Error("prompt failed"),
          })
          return {
            action: "create_session",
            session_id: "session-impl",
            task_markdown: "# Task",
          }
        },
      },
    })

    await handler(
      {
        event: "plan",
        status: "passed",
        summary: "Plan ready.",
        artifacts: { plan: "# Plan" },
        gates: { plan_written: true },
        task_graph: {
          tasks: [{ id: "T1", title: "T1", summary: "T1", depends_on: [] }],
        },
      },
      { sessionID: "session-main", agent: "superpowers-agent" },
    )

    const state = store.readCurrent()
    expect(state?.node_runs.at(-1)?.status).toBe("dispatch_failed")
    expect(state?.status).toBe("waiting_controller_decision")
  })
})
