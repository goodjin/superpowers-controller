import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { prepareExplicitStartRun } from "../controller/intake"
import { decideNextDispatches } from "../router/transition"
import type { ProjectStore } from "../state/store"
import type { WorkflowEntrypoint, WorkflowKind } from "../state/types"

export function createStartTool(store: ProjectStore): ToolDefinition {
  return tool({
    description: "Start a confirmed Superpowers workflow proposal and create the workflow run.",
    args: {
      request: tool.schema.string().describe("Confirmed user request"),
      workflow: tool.schema.string().describe("Workflow kind: feature, debug, plan-only, review, verify-finish, or parallel-investigate"),
      entrypoint: tool.schema.string().describe("Confirmed entrypoint"),
      proposal: tool.schema.string().describe("Proposal markdown that was confirmed by the user"),
      session: tool.schema.string().optional().describe("Controller session id"),
    },
    async execute(args, context) {
      const start = prepareExplicitStartRun({
        request: args.request,
        workflow: args.workflow as WorkflowKind,
        entrypoint: args.entrypoint as WorkflowEntrypoint,
        proposal: args.proposal,
        parentSessionID: args.session ?? context.sessionID,
      })
      const state = store.startRun(start)
      return JSON.stringify(
        {
          state,
          dispatches: decideNextDispatches(state),
        },
        null,
        2,
      )
    },
  })
}
