import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { ProjectStore } from "../state/store"
import { buildControllerFeedback } from "../controller/feedback"
import type { SessionOrchestrator } from "../session/orchestrator"

export function createCancelTool(
  store: ProjectStore,
  orchestrator?: Partial<Pick<SessionOrchestrator, "returnToParent">>,
): ToolDefinition {
  return tool({
    description: "Cancel a Superpowers workflow, task, or session.",
    args: {
      workflow_id: tool.schema.string().optional().describe("Workflow/run id to cancel. Defaults to current workflow."),
      task_id: tool.schema.string().optional().describe("Optional task id to cancel"),
      session_id: tool.schema.string().optional().describe("Optional session id to cancel"),
      reason: tool.schema.string().optional().describe("Short cancellation reason"),
    },
    async execute(args) {
      const state = store.cancel({
        runID: args.workflow_id,
        taskID: args.task_id,
        sessionID: args.session_id,
        reason: args.reason,
      })
      if (state.parent_session_id && orchestrator?.returnToParent) {
        await orchestrator.returnToParent({
          sessionID: state.parent_session_id,
          message: "workflow 已取消，已切回主控。",
        })
      }
      return JSON.stringify({ state, controller_feedback: buildControllerFeedback(state) }, null, 2)
    },
  })
}
