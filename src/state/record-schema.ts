import { z } from "zod"
import type { SpRecordInput } from "./types"

const nodeEventSchema = z.enum([
  "intake",
  "question",
  "design",
  "plan",
  "investigation",
  "debug",
  "red-test",
  "implementation",
  "acceptance",
  "code-review",
  "verification",
  "finish",
])

const nodeStatusSchema = z.enum(["progress", "passed", "failed", "blocked", "needs_user"])

const artifactNameSchema = z.enum([
  "request",
  "spec",
  "plan",
  "investigation",
  "root_cause",
  "red_test_log",
  "patch_summary",
  "acceptance",
  "code_review",
  "verification_log",
  "finish_note",
])

const gateNameSchema = z.enum([
  "request_confirmed",
  "design_approved",
  "spec_written",
  "plan_written",
  "root_cause_found",
  "red_test_seen",
  "implementation_done",
  "acceptance_passed",
  "code_review_passed",
  "verification_fresh",
])

const taskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    depends_on: z.array(z.string().min(1)),
    files: z.array(z.string().min(1)).optional(),
    test_commands: z.array(z.string().min(1)).optional(),
    checks: z
      .array(
        z
          .object({
            kind: z.enum(["acceptance", "verification", "code_review"]),
            status: z.enum(["pending", "running", "passed", "failed", "skipped", "stale"]),
            summary: z.string().optional(),
            session_id: z.string().optional(),
            report_path: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

const taskGraphSchema = z
  .object({
    tasks: z.array(taskSchema),
  })
  .strict()

export const spRecordInputSchema = z
  .object({
    event: nodeEventSchema,
    status: nodeStatusSchema,
    summary: z.string().min(1),
    artifacts: z.partialRecord(artifactNameSchema, z.string()).optional(),
    gates: z.partialRecord(gateNameSchema, z.boolean()).optional(),
    checks: z.string().optional(),
    findings: z.string().optional(),
    question: z
      .object({
        prompt: z.string().min(1),
        options: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    task_graph: taskGraphSchema.optional(),
  })
  .strict()

export function parseSpRecordInput(value: unknown): SpRecordInput {
  return spRecordInputSchema.parse(value) as SpRecordInput
}
