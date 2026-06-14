import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "../src/config/defaults"
import { evaluateToolGate, evaluateCompletionGate } from "../src/router/gates"
import { createInitialState } from "../src/state/transitions"

describe("evaluateToolGate", () => {
  test("strict design gate blocks mutating tools before approval", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "design",
      goal: "add a feature",
    })

    const result = evaluateToolGate({
      config: { ...DEFAULT_CONFIG, design_gate: "strict" },
      state,
      tool: "edit",
      args: {},
    })

    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("design_approved")
  })

  test("guided default warns but does not block missing design approval", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "design",
      goal: "add a feature",
    })

    const result = evaluateToolGate({
      config: DEFAULT_CONFIG,
      state,
      tool: "edit",
      args: {},
    })

    expect(result.allowed).toBe(true)
    expect(result.severity).toBe("warning")
  })

  test("strict debug gate blocks repair writes before root cause", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "debug",
      goal: "fix crash",
    })

    const result = evaluateToolGate({
      config: { ...DEFAULT_CONFIG, debug_gate: "strict" },
      state,
      tool: "patch",
      args: {},
    })

    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("root_cause_found")
  })

  test("strict tdd gate blocks production writes before red test evidence", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "execute",
      goal: "implement plan",
      gates: { plan_written: true },
    })

    const result = evaluateToolGate({
      config: { ...DEFAULT_CONFIG, tdd: "strict" },
      state,
      tool: "write",
      args: { filePath: "src/plugin.ts" },
    })

    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("red_test_seen")
  })

  test("super-agent cannot execute mutating production tools", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "execute",
      goal: "implement plan",
      gates: { plan_written: true, red_test_seen: true },
    })

    const result = evaluateToolGate({
      config: { ...DEFAULT_CONFIG, mode: "strict" },
      state,
      agent: "super-agent",
      tool: "edit",
      args: { filePath: "src/plugin.ts" },
    })

    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("super-agent")
  })
})

describe("evaluateCompletionGate", () => {
  test("strict verification gate blocks done without fresh verification", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "verify-finish",
      goal: "finish",
    })

    const result = evaluateCompletionGate({
      config: { ...DEFAULT_CONFIG, verification_gate: "strict" },
      state,
      event: "done",
    })

    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("verification_fresh")
  })
})
