import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { createReportHandler } from "./report-handler"
import { noopProgressReporter, type ProgressReporter } from "../progress/reporter"
import type { SessionOrchestrator } from "../session/orchestrator"
import type { ProjectStore } from "../state/store"
import type { WorkflowConfig } from "../config/schema"

export function createReportTool(
  store: ProjectStore,
  orchestrator: Pick<SessionOrchestrator, "dispatch"> & Partial<Pick<SessionOrchestrator, "notifyParent">>,
  progress: ProgressReporter = noopProgressReporter,
  config?: WorkflowConfig,
): ToolDefinition {
  const handler = createReportHandler({ store, orchestrator, progress, config })
  return tool({
    description: "Report a Superpowers node result, artifact, evidence, question, or task graph patch to the runtime.",
    args: {
      event: tool.schema.string().describe("Node event enum: intake, question, design, plan, investigation, debug, red-test, implementation, acceptance, code-review, verification, or finish"),
      status: tool.schema.string().describe("Node status enum: progress, passed, failed, blocked, or needs_user"),
      summary: tool.schema.string().describe("Short markdown summary of this report"),
      gates: tool.schema.record(tool.schema.string(), tool.schema.boolean()).optional().describe("Structured gate updates keyed by known gate name"),
      artifacts: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("Markdown artifact bodies keyed by known artifact name"),
      checks: tool.schema.string().optional().describe("Quality/command evidence. Example: build: passed (bun run build)\\ntest: passed"),
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
              agent: tool.schema.string().optional(),
              files: tool.schema.array(tool.schema.string()).optional(),
              test_commands: tool.schema.array(tool.schema.string()).optional(),
            }),
          ),
        })
        .optional()
        .describe("Plan task graph. depends_on is the execution contract."),
      workflow_expansion: tool.schema
        .object({
          mode: tool.schema.enum(["append", "replace"]).optional().describe("Append to or replace current workflow expansion targets."),
          reason: tool.schema.string().optional().describe("Why this node proposes or needs workflow expansion."),
          tasks: tool.schema
            .array(
              tool.schema.object({
                id: tool.schema.string(),
                title: tool.schema.string(),
                summary: tool.schema.string(),
                depends_on: tool.schema.array(tool.schema.string()),
                agent: tool.schema.string().optional(),
                files: tool.schema.array(tool.schema.string()).optional(),
                test_commands: tool.schema.array(tool.schema.string()).optional(),
              }),
            )
            .optional()
            .describe("Tasks to append or replace in the runtime task graph."),
          nodes: tool.schema
            .array(
              tool.schema.object({
                id: tool.schema.string(),
                title: tool.schema.string().optional(),
                agent: tool.schema.string(),
                phase: tool.schema.string().optional(),
                task_id: tool.schema.string().optional(),
                depends_on: tool.schema.array(tool.schema.string()).optional(),
                input_documents: tool.schema.array(tool.schema.string()).optional(),
                output_documents: tool.schema.array(tool.schema.string()).optional(),
                report_contract: tool.schema.array(tool.schema.string()).optional(),
              }),
            )
            .optional()
            .describe("Workflow nodes to append or replace when auto expansion is allowed."),
          documents: tool.schema
            .array(
              tool.schema.object({
                id: tool.schema.string(),
                path: tool.schema.string(),
                kind: tool.schema.string(),
                producer: tool.schema.enum(["controller", "plugin", "node", "recovery"]),
                consumer: tool.schema.array(tool.schema.string()).optional(),
                status: tool.schema.enum(["draft", "candidate", "approved", "current", "historical"]).optional(),
                node_id: tool.schema.string().optional(),
                task_id: tool.schema.string().optional(),
                updated_at: tool.schema.string().optional(),
              }),
            )
            .optional()
            .describe("Run-local documents produced or consumed by this expansion."),
        })
        .optional()
        .describe("Optional v5 workflow expansion patch. Runtime applies it only when auto expansion policy allows."),
    },
    async execute(args, context) {
      return handler(args, { sessionID: context.sessionID, agent: context.agent })
    },
  })
}
