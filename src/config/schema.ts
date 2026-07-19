import { z } from "zod"

export const GateModeSchema = z.enum(["strict", "guided", "off"])
export type GateMode = z.infer<typeof GateModeSchema>

/** Native-only. Legacy/hybrid config values coerce to native. */
export const InteractionModeSchema = z
  .enum(["native", "legacy", "hybrid"])
  .catch("native")
  .transform((): "native" => "native")
export type InteractionMode = "native"

export const WorkflowConfigSchema = z.object({
  $schema: z.string().optional(),
  mode: GateModeSchema.default("guided"),
  tdd: GateModeSchema.default("guided"),
  design_gate: GateModeSchema.default("guided"),
  debug_gate: GateModeSchema.default("guided"),
  verification_gate: GateModeSchema.default("guided"),
  quality_gate: GateModeSchema.default("off"),
  quality_commands: z
    .object({
      build: z.string().default("bun run build"),
      test: z.string().default("bun test"),
      lint: z.string().default("bun run lint"),
    })
    .default({ build: "bun run build", test: "bun test", lint: "bun run lint" }),
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
  liveness: z
    .object({
      enabled: z.boolean().default(true),
      timeout_ms: z.number().int().positive().default(60_000),
      check_interval_ms: z.number().int().positive().default(15_000),
    })
    .default({ enabled: true, timeout_ms: 60_000, check_interval_ms: 15_000 }),
  interaction: z
    .object({
      mode: InteractionModeSchema.default("native"),
    })
    .default({ mode: "native" }),
})

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>
