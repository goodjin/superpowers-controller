import type { TaskGraph } from "./types"

export type NormalizedTaskGraph = TaskGraph & {
  implicit_depends_on?: Array<{
    from: string
    on: string
    reason: string
  }>
}

export type TaskRunSets = {
  passed: Set<string>
  running: Set<string>
  failed: Set<string>
}

export function normalizeTaskGraph(graph: TaskGraph): NormalizedTaskGraph {
  const ids = new Set(graph.tasks.map((task) => task.id))
  for (const task of graph.tasks) {
    for (const dependency of task.depends_on) {
      if (!ids.has(dependency)) {
        throw new Error(`task graph rejected: ${task.id} has unknown dependency ${dependency}`)
      }
    }
  }

  const lastWriterByFile = new Map<string, string>()
  const implicitDependsOn: NonNullable<NormalizedTaskGraph["implicit_depends_on"]> = []
  const tasks = graph.tasks.map((task) => {
    const dependsOn = new Set(task.depends_on)
    for (const file of task.files ?? []) {
      const previousWriter = lastWriterByFile.get(file)
      if (previousWriter && !dependsOn.has(previousWriter)) {
        dependsOn.add(previousWriter)
        implicitDependsOn.push({
          from: task.id,
          on: previousWriter,
          reason: `shared writable file: ${file}`,
        })
      }
      lastWriterByFile.set(file, task.id)
    }
    return {
      ...task,
      depends_on: Array.from(dependsOn),
    }
  })

  return implicitDependsOn.length > 0 ? { tasks, implicit_depends_on: implicitDependsOn } : { tasks }
}

export function getRunnableTasks(graph: NormalizedTaskGraph, runs: TaskRunSets): NormalizedTaskGraph["tasks"] {
  return graph.tasks.filter((task) => {
    if (runs.passed.has(task.id) || runs.running.has(task.id) || runs.failed.has(task.id)) return false
    return task.depends_on.every((dependency) => runs.passed.has(dependency) && !runs.failed.has(dependency))
  })
}
