import type { WorkflowConfig } from "./schema"

export const DEFAULT_CONFIG: WorkflowConfig = {
  mode: "guided",
  tdd: "guided",
  design_gate: "guided",
  debug_gate: "guided",
  verification_gate: "guided",
  quality_gate: "off",
  quality_commands: {
    build: "bun run build",
    test: "bun test",
    lint: "bun run lint",
  },
  disabled_workflows: [],
  disabled_agents: [],
  disabled_skills: [],
  mutating_tools: ["write", "edit", "patch", "bash"],
  state: {
    scope: "project",
    retention_days: 30,
  },
  liveness: {
    enabled: true,
    timeout_ms: 300_000,
    check_interval_ms: 15_000,
  },
  interaction: {
    mode: "native",
  },
}
