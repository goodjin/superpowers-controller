import type { WorkflowConfig } from "./schema"

export const DEFAULT_CONFIG: WorkflowConfig = {
  mode: "guided",
  tdd: "guided",
  design_gate: "guided",
  debug_gate: "guided",
  verification_gate: "guided",
  disabled_workflows: [],
  disabled_agents: [],
  disabled_skills: [],
  mutating_tools: ["write", "edit", "patch", "bash"],
  state: {
    scope: "project",
    retention_days: 30,
  },
}
