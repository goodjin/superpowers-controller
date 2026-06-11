import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { DEFAULT_CONFIG } from "./defaults"
import { WorkflowConfigSchema, type WorkflowConfig } from "./schema"

export function loadConfig(directory: string, configPath?: string): WorkflowConfig {
  const path = configPath ?? join(directory, ".opencode", "superpowers.jsonc")
  if (!existsSync(path)) return DEFAULT_CONFIG

  const parsed = parse(readFileSync(path, "utf8"))
  return WorkflowConfigSchema.parse({
    ...DEFAULT_CONFIG,
    ...parsed,
    state: {
      ...DEFAULT_CONFIG.state,
      ...(parsed?.state ?? {}),
    },
  })
}
