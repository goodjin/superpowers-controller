import { describe, expect, test } from "bun:test"
import { getRunnableTasks, normalizeTaskGraph } from "../src/state/task-graph"

describe("normalizeTaskGraph", () => {
  test("adds an implicit dependency when runnable tasks write the same file", () => {
    const graph = normalizeTaskGraph({
      tasks: [
        { id: "task-a", title: "A", summary: "First change", depends_on: [], files: ["src/shared.ts"] },
        { id: "task-b", title: "B", summary: "Second change", depends_on: [], files: ["src/shared.ts"] },
        { id: "task-c", title: "C", summary: "Independent change", depends_on: [], files: ["src/other.ts"] },
      ],
    })

    expect(graph.tasks.find((task) => task.id === "task-b")?.depends_on).toEqual(["task-a"])
    expect(graph.implicit_depends_on).toEqual([{ from: "task-b", on: "task-a", reason: "shared writable file: src/shared.ts" }])
    expect(graph.tasks.find((task) => task.id === "task-c")?.depends_on).toEqual([])
  })

  test("rejects unknown dependency references", () => {
    expect(() =>
      normalizeTaskGraph({
        tasks: [{ id: "task-a", title: "A", summary: "Broken", depends_on: ["missing"] }],
      }),
    ).toThrow("unknown dependency")
  })

  test("returns tasks whose dependencies passed and excludes running or failed tasks", () => {
    const graph = normalizeTaskGraph({
      tasks: [
        { id: "task-a", title: "A", summary: "First", depends_on: [] },
        { id: "task-b", title: "B", summary: "Second", depends_on: ["task-a"] },
        { id: "task-c", title: "C", summary: "Third", depends_on: ["task-b"] },
      ],
    })

    expect(getRunnableTasks(graph, { passed: new Set(), running: new Set(), failed: new Set() }).map((task) => task.id)).toEqual(["task-a"])
    expect(
      getRunnableTasks(graph, {
        passed: new Set(["task-a"]),
        running: new Set(),
        failed: new Set(),
      }).map((task) => task.id),
    ).toEqual(["task-b"])
    expect(
      getRunnableTasks(graph, {
        passed: new Set(["task-a"]),
        running: new Set(["task-b"]),
        failed: new Set(),
      }).map((task) => task.id),
    ).toEqual([])
    expect(
      getRunnableTasks(graph, {
        passed: new Set(["task-a"]),
        running: new Set(),
        failed: new Set(["task-b"]),
      }).map((task) => task.id),
    ).toEqual([])
  })
})
