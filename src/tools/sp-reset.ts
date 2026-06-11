import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { ProjectStore } from "../state/store"

export function createResetTool(store: ProjectStore): ToolDefinition {
  return tool({
    description: "Clear the active Superpowers workflow pointer without deleting run history.",
    args: {},
    async execute() {
      store.reset()
      return "Active Superpowers workflow reset. Run history is preserved."
    },
  })
}
