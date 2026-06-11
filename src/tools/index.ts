import type { ToolDefinition } from "@opencode-ai/plugin/tool"
import type { ProjectStore } from "../state/store"
import { createNextTool } from "./sp-next"
import { createRecordTool } from "./sp-record"
import { createResetTool } from "./sp-reset"
import { createRouteTool } from "./sp-route"
import { createStateTool } from "./sp-state"

export function createTools(store: ProjectStore): Record<string, ToolDefinition> {
  return {
    sp_state: createStateTool(store),
    sp_route: createRouteTool(store),
    sp_next: createNextTool(store),
    sp_record: createRecordTool(store),
    sp_reset: createResetTool(store),
  }
}
