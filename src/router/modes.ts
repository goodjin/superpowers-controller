import type { WorkflowGate, WorkflowMode } from "../state/types"

export type ModeDefinition = {
  mode: WorkflowMode
  phase: string
  agent: string
  skills: string[]
  required_gates: WorkflowGate[]
  next: string
}

export const MODE_DEFINITIONS: Record<WorkflowMode, ModeDefinition> = {
  idle: {
    mode: "idle",
    phase: "clarify",
    agent: "superpowers",
    skills: ["superpowers-using-superpowers"],
    required_gates: [],
    next: "Ask one clarifying question.",
  },
  design: {
    mode: "design",
    phase: "explore",
    agent: "sp-designer",
    skills: ["superpowers-brainstorming"],
    required_gates: ["design_approved"],
    next: "Create and record an approved design before implementation.",
  },
  plan: {
    mode: "plan",
    phase: "write-plan",
    agent: "sp-planner",
    skills: ["superpowers-writing-plans"],
    required_gates: ["plan_written"],
    next: "Write and record an implementation plan artifact.",
  },
  execute: {
    mode: "execute",
    phase: "run-task",
    agent: "sp-implementer",
    skills: ["superpowers-test-driven-development", "superpowers-executing-plans"],
    required_gates: ["plan_written", "red_test_seen", "spec_review_passed", "code_review_passed"],
    next: "Run one planned task, then record implementation and review evidence.",
  },
  debug: {
    mode: "debug",
    phase: "find-root-cause",
    agent: "sp-debugger",
    skills: ["superpowers-systematic-debugging"],
    required_gates: ["root_cause_found"],
    next: "Find and record root cause before proposing a fix.",
  },
  "parallel-investigate": {
    mode: "parallel-investigate",
    phase: "prove-independence",
    agent: "superpowers",
    skills: ["superpowers-dispatching-parallel-agents"],
    required_gates: ["worktree_ready"],
    next: "Prove independent domains and no shared write conflicts before dispatch.",
  },
  review: {
    mode: "review",
    phase: "review-findings",
    agent: "sp-code-reviewer",
    skills: ["superpowers-requesting-code-review", "superpowers-receiving-code-review"],
    required_gates: ["spec_review_passed", "code_review_passed"],
    next: "Resolve critical and important review findings before continuing.",
  },
  "verify-finish": {
    mode: "verify-finish",
    phase: "fresh-verification",
    agent: "sp-verifier",
    skills: ["superpowers-verification-before-completion", "superpowers-finishing-a-development-branch"],
    required_gates: ["verification_fresh"],
    next: "Run fresh verification and record the evidence before claiming completion.",
  },
  "skill-authoring": {
    mode: "skill-authoring",
    phase: "pressure-scenario",
    agent: "sp-planner",
    skills: ["superpowers-writing-skills"],
    required_gates: ["spec_written", "verification_fresh"],
    next: "Define pressure scenario, baseline failure, and compliance verification.",
  },
}

export function modeDefinition(mode: WorkflowMode): ModeDefinition {
  return MODE_DEFINITIONS[mode]
}
