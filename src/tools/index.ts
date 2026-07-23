import type { ToolDefinition } from "@opencode-ai/plugin/tool"
import { noopProgressReporter, type ProgressReporter } from "../progress/reporter"
import type { SessionOrchestrator } from "../session/orchestrator"
import type { ProjectStore } from "../state/store"
import type { WorkflowConfig } from "../config/schema"
import { createCancelTool } from "./sp-cancel"
import { createPrepareTool } from "./sp-prepare"
import { createReportTool } from "./sp-report"
import { createStatusTool } from "./sp-status"
import { createStartTool } from "./sp-start"

export function createTools(
  store: ProjectStore,
  orchestrator?: Pick<SessionOrchestrator, "dispatch"> & Partial<Pick<SessionOrchestrator, "resumeNode" | "notifyParent" | "handoffController" | "returnToParent">>,
  progress: ProgressReporter = noopProgressReporter,
  config?: WorkflowConfig,
): Record<string, ToolDefinition> {
  const dispatchFallback = orchestrator ?? {
    async dispatch() {
      return {
        action: "create_session" as const,
        session_id: "session-dispatch-unavailable",
        task_markdown: "# Dispatch unavailable\n",
      }
    },
  }
  return {
    sp_status: createStatusTool(store),
    sp_prepare: createPrepareTool(store, dispatchFallback, progress),
    sp_start: createStartTool(store, orchestrator, progress),
    sp_cancel: createCancelTool(store, orchestrator),
    sp_report: createReportTool(store, dispatchFallback, progress, config),
  }
}
