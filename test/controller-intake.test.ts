import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildWorkflowProposal } from "../src/controller/proposal"
import { prepareStartRun } from "../src/controller/intake"
import { createProjectStore } from "../src/state/store"
import { createRouteTool } from "../src/tools/sp-route"
import { createStartTool } from "../src/tools/sp-start"

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
    expect(proposal.next_action).toBe("confirm_start")
  })

  test("builds a resume proposal when an active run exists", () => {
    const proposal = buildWorkflowProposal({
      request: "continue",
      existingState: {
        id: "run-1",
        project: "/repo",
        session: "session-main",
        parent_session_id: "session-main",
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

describe("sp_route and sp_start tools", () => {
  test("sp_route reports that a proposal is waiting for user confirmation", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-route-progress-"))
    try {
      const store = createProjectStore(project)
      const progress: Array<{ stage: string; message: string }> = []
      const route = createRouteTool(store, {
        async report(input) {
          progress.push({ stage: input.stage, message: input.message })
        },
      })

      await route.execute(
        {
          request: "/sp-debug fix failing tests",
          command: "/sp-debug",
        },
        toolContext,
      )

      expect(progress).toEqual([
        {
          stage: "waiting_user_confirmation",
          message: "debug workflow proposal is ready; waiting for user confirmation.",
        },
      ])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_route returns a proposal without creating a run", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-route-proposal-"))
    try {
      const store = createProjectStore(project)
      const route = createRouteTool(store)

      const output = await route.execute(
        {
          request: "/sp-debug fix failing tests",
          command: "/sp-debug",
        },
        toolContext,
      )

      const proposal = JSON.parse(toolOutput(output))
      expect(proposal.workflow).toBe("debug")
      expect(proposal.requires_confirmation).toBe(true)
      expect(store.readCurrent()).toBeNull()
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start reports that a confirmed workflow run started", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-progress-"))
    try {
      const store = createProjectStore(project)
      const progress: Array<{ stage: string; message: string }> = []
      const start = createStartTool(store, {
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
})

function toolOutput(value: unknown): string {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && "output" in value) return String((value as { output: unknown }).output)
  return String(value)
}
