import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProjectStore, readCurrentWorkflowState } from "../src/state/store"

describe("ProjectStore", () => {
  test("persists request, artifacts, task graph, and node record files in the run directory", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-store-"))
    try {
      const store = createProjectStore(project)
      const state = store.start({
        session: "session-1",
        mode: "plan",
        goal: "Build workflow gates",
      })

      expect(readFileSync(join(store.root, "runs", state.id, "request.md"), "utf8")).toContain("Build workflow gates")

      store.record({
        event: "plan",
        status: "passed",
        summary: "Plan written.",
        artifacts: { plan: "# Plan\n\nTask graph below." },
        gates: { plan_written: true },
        task_graph: {
          tasks: [
            { id: "task-a", title: "A", summary: "A", depends_on: [], files: ["src/shared.ts"] },
            { id: "task-b", title: "B", summary: "B", depends_on: [], files: ["src/shared.ts"] },
          ],
        },
      })

      const runRoot = join(store.root, "runs", state.id)
      expect(readFileSync(join(runRoot, "artifacts", "plan.md"), "utf8")).toContain("# Plan")
      expect(readFileSync(join(runRoot, "task_graph.json"), "utf8")).toContain("implicit_depends_on")
      expect(existsSync(join(runRoot, "nodes", "001-plan", "record.json"))).toBe(true)
      expect(readFileSync(join(runRoot, "changelog.md"), "utf8")).toContain("plan")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("startup recovery marks persisted running nodes as interrupted once", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-store-startup-recovery-"))
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
      const node = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-impl",
        task_id: "T3",
        task_markdown: "# Implement T3",
      })

      const recovered = store.recoverInterruptedRunningNodes({
        reason: "Plugin process started.",
      })
      const runRoot = join(store.root, "runs", state.id)
      const eventsAfterRecovery = readFileSync(join(runRoot, "events.jsonl"), "utf8")

      expect(recovered?.status).toBe("recovered_unknown")
      expect(recovered?.node_runs.find((run) => run.id === node.id)).toMatchObject({
        status: "interrupted",
        closed_at: recovered?.updated_at,
        ended_at: recovered?.updated_at,
      })
      expect(eventsAfterRecovery).toContain("startup_recovered_interrupted_nodes")
      expect(readFileSync(join(runRoot, "changelog.md"), "utf8")).toContain("startup recovered interrupted nodes")
      expect(readFileSync(join(runRoot, "nodes", node.id, "fallback-summary.json"), "utf8")).toContain("No terminal sp_report was recorded")
      expect(readFileSync(join(runRoot, "documents.json"), "utf8")).toContain("fallback_summary")

      const second = store.recoverInterruptedRunningNodes({
        reason: "Plugin process started again.",
      })
      const eventsAfterSecondRecovery = readFileSync(join(runRoot, "events.jsonl"), "utf8")

      expect(second?.status).toBe("recovered_unknown")
      expect(eventsAfterSecondRecovery).toBe(eventsAfterRecovery)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("startup recovery marks workflow-level running state as recovered even without running nodes", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-store-startup-workflow-running-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Finish usage records",
        request: "# Request\n\nFinish usage records.",
        proposal: "# Proposal\n\nRun feature workflow.",
        parentSessionID: "session-main",
      })
      const node = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        session_id: "session-impl",
        task_id: "T1",
        task_markdown: "# Implement T1",
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
      const recovered = restartedStore.readCurrent()
      const runRoot = join(store.root, "runs", state.id)
      const persisted = JSON.parse(readFileSync(join(runRoot, "state.json"), "utf8"))

      expect(recovered?.status).toBe("recovered_unknown")
      expect(recovered?.node_runs.every((run) => run.status !== "running")).toBe(true)
      expect(persisted.status).toBe("recovered_unknown")
      expect(readFileSync(join(runRoot, "events.jsonl"), "utf8")).toContain("startup_recovered_running_workflow")
      expect(readFileSync(join(runRoot, "changelog.md"), "utf8")).toContain("startup recovered workflow running status")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("startup recovery leaves draft prepared workflows unchanged", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-store-startup-draft-"))
    try {
      const store = createProjectStore(project)
      const state = store.prepareRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Prepare task panel",
        request: "# Request\n\nPrepare task panel.",
        proposal: "# Proposal\n\nPrepare feature workflow.",
        parentSessionID: "session-main",
      })

      const restartedStore = createProjectStore(project, { reconcileOnLoad: true })
      const current = restartedStore.readCurrent()
      const runRoot = join(store.root, "runs", state.id)

      expect(current?.activation).toBe("draft")
      expect(current?.status).toBe("running")
      expect(readFileSync(join(runRoot, "events.jsonl"), "utf8")).not.toContain("startup_recovered")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("readCurrentWorkflowState reads only the active run pointer", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-store-current-light-"))
    try {
      const store = createProjectStore(project)
      const first = store.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "First run",
        request: "First run",
        proposal: "First run",
        parentSessionID: "session-1",
      })
      const second = store.startRun({
        workflow: "feature",
        entrypoint: "execute",
        goal: "Second run",
        request: "Second run",
        proposal: "Second run",
        parentSessionID: "session-2",
      })

      expect(readCurrentWorkflowState(project)?.id).toBe(second.id)
      expect(readCurrentWorkflowState(project)?.id).not.toBe(first.id)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
