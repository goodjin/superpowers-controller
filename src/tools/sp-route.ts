import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { buildWorkflowProposal } from "../controller/proposal"
import type { ProjectStore } from "../state/store"

export function createRouteTool(store: ProjectStore): ToolDefinition {
  return tool({
    description: "Route a user request to the recommended Superpowers workflow mode, agent, skills, and gates.",
    args: {
      request: tool.schema.string().describe("User request or command arguments"),
      command: tool.schema.string().optional().describe("Explicit slash command, such as /sp-debug"),
      session: tool.schema.string().optional().describe("OpenCode session id"),
    },
    async execute(args, context) {
      const proposal = buildWorkflowProposal({
        request: args.request,
        command: args.command,
        existingState: store.readCurrent(),
      })
      return JSON.stringify(proposal, null, 2)
    },
  })
}
