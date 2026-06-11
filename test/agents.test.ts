import { describe, expect, test } from "bun:test"
import { createAgentConfig } from "../src/agents"
import { MODE_DEFINITIONS } from "../src/router/modes"

describe("createAgentConfig", () => {
  test("node agent prompts include every skill declared by the shared mode map", () => {
    const agents = createAgentConfig()

    for (const mode of Object.values(MODE_DEFINITIONS)) {
      if (mode.agent === "superpowers") continue
      const agent = agents[mode.agent]
      expect(agent, `${mode.agent} should be injected`).toBeDefined()
      const prompt = String(agent.prompt ?? "")
      for (const skill of mode.skills) {
        expect(prompt, `${mode.agent} should load ${skill}`).toContain(skill)
      }
    }
  })
})
