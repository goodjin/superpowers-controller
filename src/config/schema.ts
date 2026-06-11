import { z } from "zod"

export const GateModeSchema = z.enum(["strict", "guided", "off"])
export type GateMode = z.infer<typeof GateModeSchema>

export const WorkflowConfigSchema = z.object({
  $schema: z.string().optional(),
  mode: GateModeSchema.default("guided"),
  tdd: GateModeSchema.default("guided"),
  design_gate: GateModeSchema.default("guided"),
  debug_gate: GateModeSchema.default("guided"),
  verification_gate: GateModeSchema.default("guided"),
  disabled_workflows: z.array(z.string()).default([]),
  disabled_agents: z.array(z.string()).default([]),
  disabled_skills: z.array(z.string()).default([]),
  mutating_tools: z.array(z.string()).default(["write", "edit", "patch", "bash"]),
  state: z
    .object({
      scope: z.enum(["project"]).default("project"),
      retention_days: z.number().int().positive().default(30),
    })
    .default({ scope: "project", retention_days: 30 }),
})

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>
