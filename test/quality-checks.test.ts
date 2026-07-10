import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config/defaults"
import {
  evaluateQualityGateForFinish,
  mergeQualityChecksFromRecord,
  parseQualityChecksFromReport,
  validateQualityGateForRecord,
} from "../src/runtime/quality-checks"
import { buildNodeTaskPrompt, buildNodeTaskPacket } from "../src/session/templates"
import { createProjectStore } from "../src/state/store"
import type { WorkflowState } from "../src/state/types"
import { createReportHandler } from "../src/tools/report-handler"
import { createStartTool } from "../src/tools/sp-start"

function baseState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: "run-1",
    project: "/tmp/project",
    workflow: "verify-finish",
    entrypoint: "verify-finish",
    mode: "guided",
    phase: "verification",
    current_phase: "verification",
    status: "running",
    session: "session-main",
    parent_session_id: "session-main",
    activation: "active",
    node_runs: [
      {
        id: "001-finish",
        phase: "finish",
        agent: "sp-finisher",
        primary_skill: "superpowers-finish",
        session_id: "session-finish",
        status: "running",
        attempts: 1,
        started_at: "2026-07-10T00:00:00.000Z",
      },
    ],
    workflow_spec: {
      id: "spec-1",
      kind: "orchestration",
      orchestration: {
        nodes: [{ id: "001-finish", agent: "sp-finisher", phase: "finish" }],
        required_checks: ["build", "test"],
      },
    },
    ...overrides,
  }
}

describe("quality checks parsing", () => {
  test("parses line-format checks", () => {
    const parsed = parseQualityChecksFromReport("build: passed (bun run build)\ntest: failed (bun test)")
    expect(parsed).toEqual([
      { kind: "build", status: "passed", command: "bun run build", summary: "build: passed (bun run build)" },
      { kind: "test", status: "failed", command: "bun test", summary: "test: failed (bun test)" },
    ])
  })

  test("parses json-format checks", () => {
    const parsed = parseQualityChecksFromReport('{"build":{"status":"passed","command":"npm run build"}}')
    expect(parsed).toEqual([{ kind: "build", status: "passed", command: "npm run build", summary: undefined }])
  })

  test("mergeQualityChecksFromRecord stores verification and finish evidence", () => {
    const state = baseState()
    const merged = mergeQualityChecksFromRecord(
      state,
      { event: "finish", status: "passed", summary: "done", checks: "build: passed (bun run build)" },
      "001-finish",
    )
    expect(merged?.build?.status).toBe("passed")
    expect(merged?.build?.node_id).toBe("001-finish")
  })
})

describe("quality gate evaluation", () => {
  test("strict blocks finish when required checks are missing", () => {
    const gate = evaluateQualityGateForFinish({
      config: { ...DEFAULT_CONFIG, quality_gate: "strict" },
      state: baseState(),
    })
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toContain("build")
    expect(gate.reason).toContain("test")
  })

  test("guided allows finish but warns when checks are missing", () => {
    const gate = evaluateQualityGateForFinish({
      config: { ...DEFAULT_CONFIG, quality_gate: "guided" },
      state: baseState(),
    })
    expect(gate.allowed).toBe(true)
    expect(gate.severity).toBe("warning")
  })

  test("strict allows finish when same-report checks satisfy required_checks", () => {
    validateQualityGateForRecord({
      config: { ...DEFAULT_CONFIG, quality_gate: "strict" },
      state: baseState(),
      record: {
        event: "finish",
        status: "passed",
        summary: "done",
        checks: "build: passed (bun run build)\ntest: passed (bun test)",
      },
      nodeID: "001-finish",
    })
  })
})

describe("quality gate integration", () => {
  test("report-handler rejects strict finish without checks evidence", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-quality-gate-"))
    try {
      const store = createProjectStore(project)
      const started = store.startRun({
        workflow: "single-agent",
        entrypoint: "implement",
        goal: "Finish with quality gate",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      store.setWorkflowSpec({
        runID: started.id,
        parentSessionID: "session-main",
        workflowSpec: {
          id: `${started.id}-workflow-spec`,
          kind: "orchestration",
          auto_expansion: { allow: false },
          orchestration: {
            nodes: [{ id: "001-finish", agent: "sp-finisher", phase: "finish" }],
            required_checks: ["build"],
          },
        },
      })
      store.addNodeRun({
        phase: "finish",
        agent: "sp-finisher",
        primary_skill: "superpowers-finish",
        session_id: "session-finish",
        task_markdown: "# Finish",
      })
      const handler = createReportHandler({
        store,
        orchestrator: { async dispatch() { throw new Error("should not dispatch") } },
        config: { ...DEFAULT_CONFIG, quality_gate: "strict" },
      })

      await expect(
        handler(
          { event: "finish", status: "passed", summary: "done without checks" },
          { sessionID: "session-finish" },
        ),
      ).rejects.toThrow("Required quality checks missing")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("report-handler accepts strict finish when checks are included in the same report", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-quality-gate-pass-"))
    try {
      const store = createProjectStore(project)
      const started = store.startRun({
        workflow: "single-agent",
        entrypoint: "implement",
        goal: "Finish with quality gate",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
      })
      store.setWorkflowSpec({
        runID: started.id,
        parentSessionID: "session-main",
        workflowSpec: {
          id: `${started.id}-workflow-spec`,
          kind: "orchestration",
          auto_expansion: { allow: false },
          orchestration: {
            nodes: [{ id: "001-finish", agent: "sp-finisher", phase: "finish" }],
            required_checks: ["build"],
          },
        },
      })
      store.addNodeRun({
        phase: "finish",
        agent: "sp-finisher",
        primary_skill: "superpowers-finish",
        session_id: "session-finish",
        task_markdown: "# Finish",
      })
      const handler = createReportHandler({
        store,
        orchestrator: { async dispatch() { throw new Error("should not dispatch") } },
        config: { ...DEFAULT_CONFIG, quality_gate: "strict" },
      })

      const output = await handler(
        {
          event: "finish",
          status: "passed",
          summary: "done with checks",
          checks: "build: passed (bun run build)",
        },
        { sessionID: "session-finish" },
      )
      const result = JSON.parse(output)
      expect(result.state.quality_checks?.build?.status).toBe("passed")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("sp_start persists required_checks into workflow-spec.json", async () => {
    const project = mkdtempSync(join(tmpdir(), "sp-start-quality-checks-"))
    try {
      const store = createProjectStore(project)
      const prepared = store.prepareRun({
        workflow: "verify-finish",
        entrypoint: "verify-finish",
        goal: "Verify and finish",
        request: "# Request",
        proposal: "# Proposal",
        parentSessionID: "session-main",
        prepareMode: "proposal_only",
      })
      const start = createStartTool(store)
      const output = await start.execute(
        {
          prepared_task_id: prepared.id,
          action: "start_prepared_task",
          confirmation: { user_confirmed: true },
          start_config: {
            kind: "built_in_workflow",
            workflow_id: "verify-finish",
            required_checks: ["build", "lint"],
            quality_commands: { lint: "npm run lint" },
          },
        },
        { sessionID: "session-main" },
      )
      const state = JSON.parse(typeof output === "string" ? output : JSON.stringify(output)).state
      const workflowSpec = JSON.parse(readFileSync(join(store.root, "runs", state.id, "workflow-spec.json"), "utf8"))
      expect(workflowSpec.orchestration.required_checks).toEqual(["build", "lint"])
      expect(workflowSpec.orchestration.quality_commands).toEqual({ lint: "npm run lint" })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("verification packet prompt includes quality check evidence section", () => {
    const state = baseState({
      node_runs: [],
      workflow_spec: {
        id: "spec-1",
        kind: "orchestration",
        orchestration: {
          nodes: [{ id: "001-verification", agent: "sp-verifier", phase: "verification" }],
          required_checks: ["test"],
          quality_commands: { test: "npm test" },
        },
      },
    })
    const packet = buildNodeTaskPacket({
      state,
      nodeID: "001-verification",
      decision: {
        action: "create_session",
        phase: "verification",
        agent: "sp-verifier",
        primary_skill: "superpowers-verification",
        reason: "Run verification",
      },
    })
    const prompt = buildNodeTaskPrompt(packet)
    expect(prompt).toContain("Quality Check Evidence")
    expect(prompt).toContain("Required checks: test")
    expect(prompt).toContain("npm test")
    expect(prompt).toContain("checks: required for this workflow")
  })
})
