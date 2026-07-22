import type { WorkflowGate, WorkflowMode } from "../state/types"

export const AGENT_SKILL_MAP = {
  "sp-designer": "superpowers-brainstorming",
  "sp-planner": "superpowers-writing-plans",
  "sp-debugger": "superpowers-systematic-debugging",
  "sp-investigator": "superpowers-dispatching-parallel-agents",
  "sp-implementer": "superpowers-test-driven-development",
  "sp-acceptance-reviewer": "superpowers-requesting-code-review",
  "sp-code-reviewer": "superpowers-requesting-code-review",
  "sp-verifier": "superpowers-verification-before-completion",
  "sp-finisher": "superpowers-finishing-a-development-branch",
} as const

export type NodeAgentName = keyof typeof AGENT_SKILL_MAP

/** Unknown agents (e.g. planner-invented `sp-executor`) normalize to implementer. */
export function normalizeNodeAgent(agent: string | undefined): NodeAgentName {
  if (agent && agent in AGENT_SKILL_MAP) return agent as NodeAgentName
  return "sp-implementer"
}

export function isKnownNodeAgent(agent: string | undefined): agent is NodeAgentName {
  return Boolean(agent && agent in AGENT_SKILL_MAP)
}

export type ModeDefinition = {
  mode: WorkflowMode
  phase: string
  agent: "superpowers-agent" | NodeAgentName
  skills: string[]
  primary_skill?: string
  required_gates: WorkflowGate[]
  next: string
}

function nodeMode(args: {
  mode: WorkflowMode
  phase: string
  agent: NodeAgentName
  required_gates: WorkflowGate[]
  next: string
}): ModeDefinition {
  const primarySkill = AGENT_SKILL_MAP[args.agent]
  return {
    ...args,
    primary_skill: primarySkill,
    skills: [primarySkill],
  }
}

export const MODE_DEFINITIONS: Record<WorkflowMode, ModeDefinition> = {
  idle: {
    mode: "idle",
    phase: "clarify",
    agent: "superpowers-agent",
    skills: [],
    required_gates: [],
    next: "Clarify intent, detect existing workflow state, and ask for confirmation before dispatch.",
  },
  design: nodeMode({
    mode: "design",
    phase: "explore",
    agent: "sp-designer",
    required_gates: ["request_confirmed", "design_approved", "spec_written"],
    next: "Create the design/spec artifact and record design gates.",
  }),
  plan: nodeMode({
    mode: "plan",
    phase: "write-plan",
    agent: "sp-planner",
    required_gates: ["request_confirmed", "plan_written"],
    next: "Write the implementation plan and task graph artifact.",
  }),
  execute: nodeMode({
    mode: "execute",
    phase: "run-task",
    agent: "sp-implementer",
    required_gates: ["plan_written", "red_test_seen", "implementation_done"],
    next: "Execute one runnable task with TDD and record evidence.",
  }),
  debug: nodeMode({
    mode: "debug",
    phase: "find-root-cause",
    agent: "sp-debugger",
    required_gates: ["request_confirmed", "root_cause_found"],
    next: "Find and record root cause before repair.",
  }),
  "parallel-investigate": nodeMode({
    mode: "parallel-investigate",
    phase: "investigate",
    agent: "sp-investigator",
    required_gates: ["request_confirmed"],
    next: "Run read-only investigation for one independent problem domain.",
  }),
  review: nodeMode({
    mode: "review",
    phase: "acceptance",
    agent: "sp-acceptance-reviewer",
    required_gates: ["acceptance_passed", "verification_fresh", "code_review_passed"],
    next: "Run acceptance first, then verification, then code review.",
  }),
  "verify-finish": nodeMode({
    mode: "verify-finish",
    phase: "fresh-verification",
    agent: "sp-verifier",
    required_gates: ["verification_fresh"],
    next: "Run fresh verification; dispatch back to implementation when verification fails.",
  }),
}

export function modeDefinition(mode: WorkflowMode): ModeDefinition {
  return MODE_DEFINITIONS[mode]
}
