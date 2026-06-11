import { describe, expect, test } from "bun:test"
import { buildRuntimeSkillInjection } from "../src/skills/runtime-injection"
import { createInitialState } from "../src/state/transitions"

describe("buildRuntimeSkillInjection", () => {
  test("injects required skills and single-session policy for active workflow", () => {
    const state = createInitialState({
      id: "run-1",
      project: "/repo",
      session: "session-1",
      mode: "execute",
      goal: "implement the plan",
    })

    const injection = buildRuntimeSkillInjection(state)

    expect(injection).toContain("<superpowers-controller-runtime>")
    expect(injection).toContain("primary_skill: superpowers-test-driven-development")
    expect(injection).toContain("supporting_skills: superpowers-executing-plans")
    expect(injection).toContain("one primary skill per session")
    expect(injection).toContain("create or route a separate subagent session")
  })
})
