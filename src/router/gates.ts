import type { WorkflowConfig, GateMode } from "../config/schema"
import { AGENT_SKILL_MAP, type NodeAgentName } from "./modes"
import type { WorkflowState } from "../state/types"

export type GateResult = {
  allowed: boolean
  severity: "none" | "warning" | "blocked"
  reason: string
}

const CONTROLLER_DISPATCH_HINT = "Use sp_prepare, get user confirmation, then sp_start(action=\"start_prepared_task\") to dispatch node agents."

export function evaluateToolGate(args: {
  config: WorkflowConfig
  state: WorkflowState | null | undefined
  agent?: string
  tool: string
  args: Record<string, unknown>
}): GateResult {
  if (isSkillTool(args.tool) && isSuperpowersAgent(args.agent)) {
    return evaluateSkillToolGate(args.agent, args.args)
  }

  if (isNativeTaskTool(args.tool) && isSuperpowersAgent(args.agent)) {
    return {
      allowed: false,
      severity: "blocked",
      reason: `${args.agent} cannot call native task; ${CONTROLLER_DISPATCH_HINT}`,
    }
  }

  if (args.agent === "superpowers-agent" && isBashTool(args.tool)) {
    return {
      allowed: false,
      severity: "blocked",
      reason: `superpowers-agent cannot execute shell commands; ${CONTROLLER_DISPATCH_HINT}`,
    }
  }

  const state = args.state
  if (!state || !isMutatingTool(args.config, args.tool, args.args)) {
    return allow()
  }

  if (state.mode === "design" && state.gates.design_approved !== true) {
    return resultForMode(args.config.design_gate, "design_approved gate is required before mutating files")
  }

  if (state.mode === "execute" && state.gates.plan_written !== true) {
    return resultForMode(args.config.mode, "plan_written gate is required before executing tasks")
  }

  if (state.mode === "debug" && state.gates.root_cause_found !== true) {
    return resultForMode(args.config.debug_gate, "root_cause_found gate is required before repair writes")
  }

  if (isProductionWrite(args.args) && state.gates.red_test_seen !== true) {
    return resultForMode(args.config.tdd, "red_test_seen gate is required before production code writes")
  }

  if (args.agent === "superpowers-agent") {
    return resultForMode(args.config.mode, `superpowers-agent cannot execute mutating production tools; ${CONTROLLER_DISPATCH_HINT}`)
  }

  return allow()
}

function isSkillTool(tool: string): boolean {
  return tool.toLowerCase().replace(/^mcp_/, "") === "skill"
}

function isNativeTaskTool(tool: string): boolean {
  return tool.toLowerCase().replace(/^mcp_/, "") === "task"
}

function isBashTool(tool: string): boolean {
  return tool.toLowerCase().replace(/^mcp_/, "") === "bash"
}

function isSuperpowersAgent(agent: string | undefined): boolean {
  return agent === "superpowers-agent" || agent?.startsWith("sp-") === true
}

function evaluateSkillToolGate(agent: string | undefined, toolArgs: Record<string, unknown>): GateResult {
  if (agent === "superpowers-agent") {
    return {
      allowed: false,
      severity: "blocked",
      reason: `superpowers-agent cannot load skills; ${CONTROLLER_DISPATCH_HINT}`,
    }
  }
  if (isNodeAgentName(agent)) {
    const requested = requestedSkill(toolArgs)
    const primarySkill = AGENT_SKILL_MAP[agent]
    if (!requested || requested === primarySkill) return allow()
    return {
      allowed: false,
      severity: "blocked",
      reason: `${agent} can only load assigned primary skill ${primarySkill}`,
    }
  }
  return allow()
}

function isNodeAgentName(agent: string | undefined): agent is NodeAgentName {
  return agent !== undefined && agent in AGENT_SKILL_MAP
}

function requestedSkill(args: Record<string, unknown>): string | undefined {
  for (const key of ["skill", "name", "id"]) {
    const value = args[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

export function evaluateCompletionGate(args: {
  config: WorkflowConfig
  state: WorkflowState | null | undefined
  event: string
}): GateResult {
  if (!args.state || !/\b(done|pass|passed|fixed|complete|completed)\b/i.test(args.event)) return allow()
  if (args.state.gates.verification_fresh === true) return allow()
  return resultForMode(args.config.verification_gate, "verification_fresh gate is required before completion claims")
}

function isMutatingTool(config: WorkflowConfig, tool: string, args: Record<string, unknown>): boolean {
  const normalized = tool.toLowerCase().replace(/^mcp_/, "")
  if (!config.mutating_tools.includes(normalized)) return false
  if (normalized !== "bash") return true
  const command = String(args.command ?? "")
  return /(>|>>|\brm\b|\bmv\b|\bcp\b|\bgit\s+(commit|add|checkout|switch|merge|rebase|reset)\b|\bnpm\s+install\b|\bbun\s+add\b|\bpnpm\s+add\b|\byarn\s+add\b|\b--update-snapshots?\b)/i.test(command)
}

function isProductionWrite(args: Record<string, unknown>): boolean {
  const path = String(args.filePath ?? args.path ?? args.file ?? "")
  if (!path) return true
  return !/(^|\/)(test|tests|__tests__|docs|assets)\//i.test(path) && !/(\.test\.|\.spec\.)/i.test(path)
}

function resultForMode(mode: GateMode, reason: string): GateResult {
  if (mode === "off") return allow()
  if (mode === "strict") return { allowed: false, severity: "blocked", reason }
  return { allowed: true, severity: "warning", reason }
}

function allow(): GateResult {
  return { allowed: true, severity: "none", reason: "allowed" }
}
