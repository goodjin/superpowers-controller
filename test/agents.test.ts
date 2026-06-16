import { describe, expect, test } from "bun:test"
import { createAgentConfig } from "../src/agents"
import { AGENT_SKILL_MAP } from "../src/router/modes"

describe("createAgentConfig", () => {
  test("injects the final controller and node agents", () => {
    const agents = createAgentConfig()

    expect(Object.keys(agents).sort()).toEqual([
      "sp-code-reviewer",
      "sp-debugger",
      "sp-designer",
      "sp-finisher",
      "sp-implementer",
      "sp-investigator",
      "sp-planner",
      "sp-spec-reviewer",
      "sp-verifier",
      "super-agent",
    ])
  })

  test("node agent prompts include exactly one primary skill from the shared skill map", () => {
    const agents = createAgentConfig()

    for (const [agentName, primarySkill] of Object.entries(AGENT_SKILL_MAP)) {
      const agent = agents[agentName]
      expect(agent, `${agentName} should be injected`).toBeDefined()
      const prompt = String(agent.prompt ?? "")
      const permission = agent.permission as { skill?: Record<string, string> } | undefined
      expect(prompt, `${agentName} should load ${primarySkill}`).toContain(primarySkill)
      expect(prompt, `${agentName} should describe one primary skill`).toContain("Primary skill:")
      expect(prompt, `${agentName} should not mention control-plane fields`).toContain("Do not include next_action")
      expect(permission?.skill?.["*"], `${agentName} should deny unrelated global skills`).toBe("deny")
      expect(permission?.skill?.[primarySkill], `${agentName} should allow only its primary skill`).toBe("allow")
    }
  })

  test("controller cannot mutate code directly", () => {
    const controller = createAgentConfig()["super-agent"]

    expect(controller?.mode).toBe("primary")
    expect((controller?.permission as { edit?: string } | undefined)?.edit).toBe("deny")
    expect((controller?.tools as { skill?: boolean } | undefined)?.skill).toBe(false)
    expect(String(controller?.prompt ?? "")).toContain("create or reuse child sessions")
    expect(String(controller?.prompt ?? "")).toContain("Do not load business or development skills")
  })
})
