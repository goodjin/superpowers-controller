import type { ToolDefinition } from "@opencode-ai/plugin/tool"
import type { SessionOrchestrator } from "../session/orchestrator"
import type { ProjectStore } from "../state/store"
import { createNextTool } from "./sp-next"
import { createRecordTool } from "./sp-record"
import { createResetTool } from "./sp-reset"
import { createRouteTool } from "./sp-route"
import { createStateTool } from "./sp-state"
import { createStartTool } from "./sp-start"

export function createTools(store: ProjectStore, orchestrator?: Pick<SessionOrchestrator, "dispatch">): Record<string, ToolDefinition> {
  return {
    sp_state: createStateTool(store),
    sp_route: createRouteTool(store),
    sp_start: createStartTool(store),
    sp_next: createNextTool(store),
    sp_record: createRecordTool(store, orchestrator),
    sp_reset: createResetTool(store),
  }
}
