import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { buildWorkflowProposal } from "../controller/proposal"
import { noopProgressReporter, type ProgressReporter } from "../progress/reporter"
import type { ProjectStore } from "../state/store"

export function createRouteTool(store: ProjectStore, progress: ProgressReporter = noopProgressReporter): ToolDefinition {
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
      await progress.report({
        stage: "waiting_user_confirmation",
        title: "Superpowers workflow",
        message:
          proposal.next_action === "confirm_resume"
            ? `${proposal.workflow} workflow resume proposal is ready; waiting for user confirmation.`
            : `${proposal.workflow} workflow proposal is ready; waiting for user confirmation.`,
        variant: "info",
      })
      return JSON.stringify(proposal, null, 2)
    },
  })
}
