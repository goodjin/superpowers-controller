import { describe, expect, test } from "bun:test"
import { parseSpRecordInput } from "../src/state/record-schema"

describe("parseSpRecordInput", () => {
  test("accepts a design record with markdown spec artifact", () => {
    const record = parseSpRecordInput({
      event: "design",
      status: "passed",
      summary: "Design completed.",
      artifacts: { spec: "# Spec\n\nDesign details." },
      gates: { design_approved: true, spec_written: true },
    })

    expect(record.event).toBe("design")
    expect(record.status).toBe("passed")
    expect(record.artifacts?.spec).toContain("# Spec")
  })

  test("accepts a needs_user record with a question", () => {
    const record = parseSpRecordInput({
      event: "question",
      status: "needs_user",
      summary: "Need confirmation.",
      question: {
        prompt: "Use strict gates?",
        options: [
          { label: "guided", description: "Continue with guided gates." },
          { label: "strict" },
        ],
      },
    })

    expect(record.question?.prompt).toContain("strict")
    expect(record.question?.options).toEqual([
      { label: "guided", description: "Continue with guided gates." },
      { label: "strict" },
    ])
  })

  test("normalizes legacy string question options", () => {
    const record = parseSpRecordInput({
      event: "question",
      status: "needs_user",
      summary: "Need confirmation.",
      question: {
        prompt: "Use strict gates?",
        options: ["guided", "strict"],
      },
    })

    expect(record.question?.options).toEqual([{ label: "guided" }, { label: "strict" }])
  })

  test("accepts a simple task graph where depends_on expresses parallelism", () => {
    const record = parseSpRecordInput({
      event: "plan",
      status: "passed",
      summary: "Plan completed.",
      gates: { plan_written: true },
      artifacts: { plan: "# Plan" },
      task_graph: {
        tasks: [
          { id: "task-a", title: "A", summary: "Independent A", depends_on: [], files: ["src/a.ts"] },
          { id: "task-b", title: "B", summary: "Independent B", depends_on: [], files: ["src/b.ts"] },
          { id: "task-c", title: "C", summary: "After A", depends_on: ["task-a"] },
        ],
      },
    })

    expect(record.task_graph?.tasks[0]?.depends_on).toEqual([])
    expect(record.task_graph?.tasks[2]?.depends_on).toEqual(["task-a"])
  })

  test("rejects model-supplied control-plane fields", () => {
    expect(() =>
      parseSpRecordInput({
        event: "verification",
        status: "failed",
        summary: "Tests failed.",
        next_action: "retry",
      }),
    ).toThrow()

    expect(() =>
      parseSpRecordInput({
        event: "implementation",
        status: "passed",
        summary: "Done.",
        child_session_id: "ses_123",
      }),
    ).toThrow()
  })
})
