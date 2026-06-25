import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProjectStore } from "../src/state/store"

describe("ProjectStore node runs", () => {
  test("creates node_runs and writes plugin-generated task packets", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-node-runs-"))
    try {
      const store = createProjectStore(project)
      const state = store.startRun({
        workflow: "feature",
        entrypoint: "feature",
        goal: "Add workflow gates",
        request: "# Request\n\nAdd workflow gates.",
        proposal: "# Proposal\n\nfeature workflow",
        parentSessionID: "session-main",
      })

      const node = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-node",
        task_id: "T1",
        task_markdown: "# Superpowers Node Task\n\nImplement T1.",
      })

      const runRoot = join(store.root, "runs", state.id)
      const persisted = store.readCurrent()
      expect(persisted?.status).toBe("running")
      expect(persisted?.current_phase).toBe("implement")
      expect(persisted?.node_runs).toHaveLength(1)
      expect(persisted?.node_runs[0]).toMatchObject({
        id: node.id,
        task_id: "T1",
        session_id: "session-node",
        status: "running",
        attempts: 1,
      })
      expect(readFileSync(join(runRoot, "nodes", node.id, "task.md"), "utf8")).toContain("Implement T1")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("recordNodeResult completes the matching running node and writes record/output files", () => {
    const project = mkdtempSync(join(tmpdir(), "sp-node-record-"))
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
      const node = store.addNodeRun({
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-node",
        task_id: "T1",
        task_markdown: "# Task",
      })

      const next = store.recordNodeResult({
        nodeID: node.id,
        input: {
          event: "implementation",
          status: "passed",
          summary: "Implemented.",
          artifacts: { patch_summary: "# Patch" },
          gates: { implementation_done: true },
        },
      })

      const completed = next.node_runs.find((run) => run.id === node.id)
      expect(completed?.status).toBe("passed")
      expect(completed?.record_path).toBe(`nodes/${node.id}/record.json`)
      expect(completed?.ended_at).toBeDefined()
      expect(existsSync(join(store.root, "runs", next.id, "nodes", node.id, "record.json"))).toBe(true)
      expect(readFileSync(join(store.root, "runs", next.id, "nodes", node.id, "output.md"), "utf8")).toContain("Implemented.")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
