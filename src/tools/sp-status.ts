import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { buildWorkflowStatusSnapshot } from "../status/workflow-status"
import type { ProjectStore } from "../state/store"
import type { WorkflowState } from "../state/types"
import { buildControllerFeedback } from "../controller/feedback"

const INCOMPLETE_STATUSES = new Set<WorkflowState["status"]>([
  "intake",
  "running",
  "awaiting_design_approval",
  "awaiting_plan_approval",
  "waiting_user",
  "waiting_user_decision",
  "blocked",
  "failed",
  "recovered_unknown",
])

export function createStatusTool(store: ProjectStore): ToolDefinition {
  return tool({
    description: "Query current Superpowers workflow status, a specific workflow, or incomplete historical workflows.",
    args: {
      workflow_id: tool.schema.string().optional().describe("Optional workflow/run id to inspect"),
      task_id: tool.schema.string().optional().describe("Optional task id to focus on"),
      session_id: tool.schema.string().optional().describe("Optional child or parent session id to focus on"),
      include_history: tool.schema.boolean().optional().describe("Include incomplete historical workflows"),
      detail: tool.schema.enum(["summary", "task", "sessions", "full"]).optional().describe("Detail level for the status response"),
      include_progress: tool.schema.boolean().optional().describe("Include recent node progress events from progress.jsonl"),
      progress_tail: tool.schema.number().optional().describe("Number of recent progress events per node when include_progress is true"),
    },
    async execute(args) {
      const current = args.workflow_id ? store.readRun(args.workflow_id) : store.readCurrent()
      const history = args.include_history || !current ? incompleteRuns(store.listRuns()) : undefined
      const snapshot = current
        ? buildWorkflowStatusSnapshot({
            state: current,
            detail: args.detail,
            taskID: args.task_id,
            sessionID: args.session_id,
            includeProgress: args.include_progress,
            progressTail: args.progress_tail,
          })
        : undefined
      return JSON.stringify(
        {
          source: snapshot?.source ?? "history_scan",
          current: snapshot?.current,
          summary: snapshot?.summary,
          task: snapshot?.task,
          sessions: snapshot?.sessions,
          runtime: snapshot?.runtime,
          durable: snapshot?.durable,
          progress_digest: snapshot?.progress_digest,
          recommended_next: snapshot?.recommended_next,
          allowed_controller_decisions: snapshot?.allowed_controller_decisions,
          controller_feedback: current ? buildControllerFeedback(current) : undefined,
          incomplete_workflows: history,
        },
        null,
        2,
      )
    },
  })
}

function incompleteRuns(runs: WorkflowState[]): WorkflowState[] {
  return runs.filter((run) => INCOMPLETE_STATUSES.has(run.status))
}
