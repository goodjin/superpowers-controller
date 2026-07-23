import { describe, expect, test } from "bun:test"
import { buildNodeTaskPacket, buildNodeTaskPrompt } from "../src/session/templates"
import type { WorkflowState } from "../src/state/types"

function baseState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: "run-1",
    project: "/repo",
    session: "session-main",
    parent_session_id: "session-main",
    activation: "draft",
    workflow: "feature",
    entrypoint: "feature",
    limited_context: false,
    mode: "design",
    phase: "design",
    current_phase: "design",
    status: "running",
    goal: "Ship design brief mode",
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
    gates: {},
    artifacts: {},
    node_runs: [],
    history: [],
    ...overrides,
  }
}

describe("design brief mode packets", () => {
  test("design node packets include brief mode context and source artifacts", () => {
    const packet = buildNodeTaskPacket({
      state: baseState(),
      nodeID: "001-design",
      decision: {
        action: "create_session",
        phase: "design",
        agent: "sp-designer",
        primary_skill: "superpowers-brainstorming",
        reason: "prepare candidate design from controller brief",
      },
    })

    expect(packet.objective).toContain("Do not interview the user")
    expect(packet.required_artifacts.map((item) => item.path)).toEqual([
      "request.md",
      "task.md",
      "proposal.md",
    ])
    expect(packet.context_sections?.some((section) => section.title === "Design Brief Mode")).toBe(true)

    const prompt = buildNodeTaskPrompt(packet)
    expect(prompt).toContain("Design Brief Mode")
    expect(prompt).toContain("sp_report(status=blocked)")
    expect(prompt).not.toContain("For design sessions, wait for the user reply in this session")
  })
})
