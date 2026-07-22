import { describe, expect, test } from "bun:test"
import { createAgentConfig } from "../src/agents"
import { AGENT_SKILL_MAP } from "../src/router/modes"

describe("createAgentConfig", () => {
  test("injects the final controller and node agents", () => {
    const agents = createAgentConfig()

    expect(Object.keys(agents).sort()).toEqual([
      "sp-acceptance-reviewer",
      "sp-code-reviewer",
      "sp-debugger",
      "sp-designer",
      "sp-finisher",
      "sp-implementer",
      "sp-investigator",
      "sp-planner",
      "sp-verifier",
      "superpowers-agent",
    ])
  })

  test("node agent prompts include exactly one primary skill from the shared skill map", () => {
    const agents = createAgentConfig()

    for (const [agentName, primarySkill] of Object.entries(AGENT_SKILL_MAP)) {
      const agent = agents[agentName]
      expect(agent, `${agentName} should be injected`).toBeDefined()
      const prompt = String(agent.prompt ?? "")
      const permission = agent.permission as { skill?: Record<string, string> } | undefined
      const tools = agent.tools as { task?: boolean; question?: boolean } | undefined
      expect(prompt, `${agentName} should load ${primarySkill}`).toContain(primarySkill)
      expect(prompt, `${agentName} should describe one primary skill`).toContain("Primary skill:")
      expect(prompt, `${agentName} should not mention control-plane fields`).toContain("Do not include next_action")
      expect(prompt, `${agentName} should route user input through sp_report`).toContain("status needs_user")
      expect(permission?.skill?.["*"], `${agentName} should deny unrelated global skills`).toBe("deny")
      expect(permission?.skill?.[primarySkill], `${agentName} should allow only its primary skill`).toBe("allow")
      expect(tools?.task, `${agentName} should hide native task`).toBe(false)
      expect(tools?.question, `${agentName} should hide native question`).toBe(false)
    }
  })

  test("controller cannot mutate code directly", () => {
    const controller = createAgentConfig()["superpowers-agent"]

    expect(controller?.mode).toBe("primary")
    expect((controller?.permission as { edit?: string } | undefined)?.edit).toBe("deny")
    expect((controller?.permission as { bash?: string } | undefined)?.bash).toBe("deny")
    expect((controller?.permission as { task?: string } | undefined)?.task).toBe("deny")
    expect((controller?.tools as { skill?: boolean } | undefined)?.skill).toBe(false)
    expect((controller?.tools as { task?: boolean } | undefined)?.task).toBe(false)
      expect(String(controller?.prompt ?? "")).toContain("clarify with the user")
      expect(String(controller?.prompt ?? "")).toContain("call sp_prepare")
      expect(String(controller?.prompt ?? "")).toContain("waiting_user")
      expect(String(controller?.prompt ?? "")).toContain("pending_question")
      expect(String(controller?.prompt ?? "")).toContain("ask the user")
      expect(String(controller?.prompt ?? "")).toContain("sp_start")
      expect(String(controller?.prompt ?? "")).toContain("resume_input")
      expect(String(controller?.prompt ?? "")).toContain("sp_status with include_progress")
      expect(String(controller?.prompt ?? "")).toContain("detail=\"sessions\"")
      expect(String(controller?.prompt ?? "")).toContain("detail=\"full\"")
      expect(String(controller?.prompt ?? "")).toContain("Do not load business or development skills")
  })

  test("controller prompt requires the v5 first-response greeting and workflow protocol", () => {
    const controller = createAgentConfig()["superpowers-agent"]
    const prompt = String(controller?.prompt ?? "")

    expect(prompt).toContain("欢迎使用superpowers主控插件，我将按superpowers工作流程完成您的任务。")
    expect(prompt).toContain("every new superpowers-agent session")
    expect(prompt).toContain("sp_status(include_capabilities=true)")
    expect(prompt).toContain("action=start_prepared_task")
    expect(prompt).toContain("clean_handoff=true")
    expect(prompt).toContain("design-only/plan-only/review-only")
    expect(prompt).toContain("waiting_controller_decision")
  })

  test("controller prompt guides recovered_unknown resume without retry_node", () => {
    const prompt = String(createAgentConfig()["superpowers-agent"]?.prompt ?? "")

    expect(prompt).toContain("recovered_unknown")
    expect(prompt).toContain('resume="all"')
    expect(prompt).toContain("resume=[task_id]")
    expect(prompt).toContain("Do not call sp_start(run_id) without resume")
    expect(prompt).toContain("Do not invent resolve_controller_decision retry_node payloads")
  })

  test("inherits global allow permissions for controller and node agents", () => {
    const agents = createAgentConfig({ globalPermission: "allow" })

    for (const [agentName, agent] of Object.entries(agents)) {
      const permission = agent.permission as Record<string, unknown>
      expect(permission.edit, `${agentName} edit permission`).toBe("allow")
      expect(permission.bash, `${agentName} bash permission`).toBe("allow")
      expect(permission.task, `${agentName} task permission`).toBe("deny")
      expect(permission.skill, `${agentName} skill permission`).toBe(agentName === "superpowers-agent" ? "deny" : "allow")
      expect(permission.question, `${agentName} question permission`).toBe(agentName === "superpowers-agent" ? "allow" : "deny")
      expect(permission.plan_enter, `${agentName} plan enter permission`).toBe("allow")
      expect(permission.plan_exit, `${agentName} plan exit permission`).toBe("allow")
      expect(permission.external_directory, `${agentName} external directory permission`).toBe("allow")
      expect(permission.doom_loop, `${agentName} doom loop permission`).toBe("allow")
      expect((permission.read as Record<string, string>)["*"], `${agentName} read permission`).toBe("allow")
      expect((permission.read as Record<string, string>)["*.env"], `${agentName} env read permission`).toBe("allow")
      expect((permission.read as Record<string, string>)["*.env.*"], `${agentName} env variant read permission`).toBe("allow")
      expect((agent.tools as { task?: boolean } | undefined)?.task, `${agentName} native task tool`).toBe(false)
      if (agentName !== "superpowers-agent") {
        expect((agent.tools as { question?: boolean } | undefined)?.question, `${agentName} native question tool`).toBe(false)
      }
    }

    expect((agents["superpowers-agent"]?.tools as { skill?: boolean; task?: boolean } | undefined)?.skill).toBe(false)
    expect((agents["superpowers-agent"]?.tools as { skill?: boolean; task?: boolean } | undefined)?.task).toBe(false)
    expect(String(agents["superpowers-agent"]?.prompt ?? "")).toContain("Never call the native task tool")
  })

  test("node agents allow bash by default without host permission", () => {
    const agents = createAgentConfig()
    expect((agents["sp-implementer"]?.permission as { bash?: string } | undefined)?.bash).toBe("allow")
    expect((agents["sp-verifier"]?.permission as { bash?: string } | undefined)?.bash).toBe("allow")
  })

  test("inherits granular host permission rules while preserving control-plane denies", () => {
    const agents = createAgentConfig({
      globalPermission: {
        edit: {
          "*": "ask",
          "src/**": "allow",
        },
        bash: {
          "*": "ask",
          "git status *": "allow",
        },
        external_directory: {
          "*": "ask",
          "/tmp/*": "allow",
        },
        task: "allow",
        question: "allow",
        skill: "allow",
      },
    })

    const controllerPermission = agents["superpowers-agent"]?.permission as Record<string, unknown>
    const implementerPermission = agents["sp-implementer"]?.permission as Record<string, unknown>

    expect(controllerPermission.edit).toEqual({ "*": "ask", "src/**": "allow" })
    expect(controllerPermission.bash).toBe("deny")
    expect(controllerPermission.external_directory).toEqual({ "*": "ask", "/tmp/*": "allow" })
    expect(controllerPermission.task).toBe("deny")
    expect(controllerPermission.question).toBe("allow")
    expect(controllerPermission.skill).toBe("deny")

    expect(implementerPermission.edit).toEqual({ "*": "ask", "src/**": "allow" })
    expect(implementerPermission.bash).toBe("allow")
    expect(implementerPermission.external_directory).toEqual({ "*": "ask", "/tmp/*": "allow" })
    expect(implementerPermission.task).toBe("deny")
    expect(implementerPermission.question).toBe("deny")
    expect(implementerPermission.skill).toBe("allow")
  })
})
