import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { ProjectStore } from "../state/store"

export function createStateTool(store: ProjectStore): ToolDefinition {
  return tool({
    description: "Read the active Superpowers workflow state for this project.",
    args: {},
    async execute() {
      return JSON.stringify(store.readCurrent() ?? { active: false }, null, 2)
    },
  })
}
