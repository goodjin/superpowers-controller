import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { decideNextDispatches } from "../router/transition"
import type { ProjectStore } from "../state/store"

export function createNextTool(store: ProjectStore): ToolDefinition {
  return tool({
    description: "Return the controller-facing dispatch summary for the active Superpowers workflow.",
    args: {},
    async execute() {
      const state = store.readCurrent()
      if (!state) return "No active Superpowers workflow. Call sp_route and sp_start first."
      return JSON.stringify(
        {
          run: state.id,
          workflow: state.workflow,
          entrypoint: state.entrypoint,
          status: state.status,
          current_phase: state.current_phase,
          gates: state.gates,
          node_runs: state.node_runs,
          pending_question: state.pending_question,
          dispatches: decideNextDispatches(state),
        },
        null,
        2,
      )
    },
  })
}
