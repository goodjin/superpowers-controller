import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { createReportHandler } from "./report-handler"
import { noopProgressReporter, type ProgressReporter } from "../progress/reporter"
import type { SessionOrchestrator } from "../session/orchestrator"
import type { ProjectStore } from "../state/store"

export function createReportTool(
  store: ProjectStore,
  orchestrator: Pick<SessionOrchestrator, "dispatch">,
  progress: ProgressReporter = noopProgressReporter,
): ToolDefinition {
  const handler = createReportHandler({ store, orchestrator, progress })
  return tool({
    description: "Report a Superpowers node result, artifact, evidence, question, or task graph patch to the runtime.",
    args: {
      event: tool.schema.string().describe("Node event enum: intake, question, design, plan, investigation, debug, red-test, implementation, acceptance, code-review, verification, or finish"),
      status: tool.schema.string().describe("Node status enum: progress, passed, failed, blocked, or needs_user"),
      summary: tool.schema.string().describe("Short markdown summary of this report"),
      gates: tool.schema.record(tool.schema.string(), tool.schema.boolean()).optional().describe("Structured gate updates keyed by known gate name"),
      artifacts: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("Markdown artifact bodies keyed by known artifact name"),
      checks: tool.schema.string().optional().describe("Markdown checks or command evidence"),
      findings: tool.schema.string().optional().describe("Markdown findings"),
      question: tool.schema
        .object({
          prompt: tool.schema.string(),
          options: tool.schema
            .array(
              tool.schema.object({
                label: tool.schema.string(),
                description: tool.schema.string().optional(),
              }),
            )
            .optional(),
        })
        .optional()
        .describe("Question for the user when status is needs_user. options must be [{ label, description? }]."),
      task_graph: tool.schema
        .object({
          tasks: tool.schema.array(
            tool.schema.object({
              id: tool.schema.string(),
              title: tool.schema.string(),
              summary: tool.schema.string(),
              depends_on: tool.schema.array(tool.schema.string()),
              files: tool.schema.array(tool.schema.string()).optional(),
              test_commands: tool.schema.array(tool.schema.string()).optional(),
            }),
          ),
        })
        .optional()
        .describe("Plan task graph. depends_on is the execution contract."),
    },
    async execute(args, context) {
      return handler(args, { sessionID: context.sessionID, agent: context.agent })
    },
  })
}
