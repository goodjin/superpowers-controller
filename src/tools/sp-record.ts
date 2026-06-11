import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { ProjectStore } from "../state/store"

export function createRecordTool(store: ProjectStore): ToolDefinition {
  return tool({
    description: "Record a Superpowers node result, artifact, evidence, and validated gate update.",
    args: {
      event: tool.schema.string().describe("Node event name, such as root-cause-found or plan-written"),
      phase: tool.schema.string().optional().describe("New workflow phase"),
      reason: tool.schema.string().optional().describe("Short reason for the transition"),
      next: tool.schema.string().optional().describe("Suggested next step"),
      skills_used: tool.schema.array(tool.schema.string()).optional().describe("Skills loaded and followed by this node"),
      gates: tool.schema.record(tool.schema.string(), tool.schema.boolean()).optional().describe("Requested gate updates"),
      artifacts: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("Markdown artifact bodies keyed by artifact name"),
    },
    async execute(args) {
      const next = store.record({
        event: args.event,
        phase: args.phase,
        reason: args.reason,
        next: args.next,
        skills_used: args.skills_used,
        gates: args.gates as never,
        artifacts: args.artifacts as never,
      })
      return JSON.stringify(next, null, 2)
    },
  })
}
