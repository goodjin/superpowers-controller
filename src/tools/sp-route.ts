import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { routeWorkflow } from "../router/route"
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
      const decision = routeWorkflow({
        request: args.request,
        command: args.command,
        currentState: store.readCurrent(),
      })
      if (decision.mode !== "idle" && decision.reason.startsWith("matched")) {
        store.start({
          session: args.session ?? context.sessionID,
          mode: decision.mode,
          goal: args.request,
        })
      }
      return JSON.stringify(decision, null, 2)
    },
  })
}
